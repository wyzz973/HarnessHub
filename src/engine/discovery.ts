import { constants } from "node:fs";
import { access, lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { EngineCandidate, EngineRegistration } from "../domain/engines.js";
import { HubError } from "../domain/errors.js";
import { normalizeEngine } from "./registry.js";
import { builtinEngines, type BuiltinEngine } from "./builtins.js";

interface DiscoveryOptions {
  cwd: string;
  home: string;
  pathEnv: string;
  nodeExecutable: string;
  manifestDir?: string;
  includeManifests?: boolean;
  /** Physical system search roots; tests inject private directories instead. */
  systemBinDirectories?: readonly string[];
}

const verificationNote =
  "Installation evidence only; authentication, model availability and task execution have not been checked.";

function missing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function fileExists(
  location: string,
  executable = false,
): Promise<boolean> {
  try {
    if (!(await stat(location)).isFile()) return false;
    await access(location, executable ? constants.X_OK : constants.R_OK);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    if (error instanceof Error && "code" in error && error.code === "EACCES")
      return false;
    throw error;
  }
}

async function locate(
  names: string[],
  directories: string[],
): Promise<string | undefined> {
  for (const directory of directories) {
    for (const name of names) {
      const location = path.join(directory, name);
      if (await fileExists(location, true)) return location;
    }
  }
  return undefined;
}

function searchDirectories(options: DiscoveryOptions): string[] {
  return Array.from(
    new Set([
      ...options.pathEnv
        .split(path.delimiter)
        .filter((directory) => directory.length > 0)
        .map((directory) => path.resolve(options.cwd, directory)),
    ]),
  );
}

async function nativeCandidate(
  definition: BuiltinEngine,
  options: DiscoveryOptions,
  directories: string[],
): Promise<EngineCandidate | undefined> {
  const { id } = definition;
  const onPath = await locate([definition.binary], directories);
  const executable =
    onPath ??
    (await locate(
      [definition.binary],
      fallbackDirectories(options, definition),
    ));
  if (!executable) return undefined;
  const candidate: EngineCandidate = {
    id,
    name: definition.name,
    executable,
    source: onPath ? "path" : "known-location",
    status: "ready",
    notes: [verificationNote, ...(definition.notes ?? [])],
  };
  if (definition.launch.kind !== "managed-acp") {
    return recipeCandidate(candidate, definition, options, directories);
  }
  let command: string[];
  if (id === "codex" || id === "claude") {
    const adapterName = id === "codex" ? "codex-acp" : "claude-agent-acp";
    const adapter = path.join(
      options.cwd,
      ".tools",
      "adapters",
      "node_modules",
      "@agentclientprotocol",
      adapterName,
      "dist",
      "index.js",
    );
    if (!(await fileExists(adapter))) {
      candidate.status = "adapter-required";
      candidate.notes.push(
        `Install a pinned @agentclientprotocol/${adapterName} adapter in .tools/adapters before ACP registration.`,
      );
      return candidate;
    }
    command = [
      "/usr/bin/env",
      ...(id === "codex"
        ? [
            `CODEX_HOME=${path.join(options.home, ".codex")}`,
            `CODEX_PATH=${executable}`,
            "INITIAL_AGENT_MODE=read-only",
          ]
        : [
            `HOME=${options.home}`,
            `CLAUDE_CODE_EXECUTABLE=${executable}`,
            "CLAUDE_CODE_SAFE_MODE=1",
          ]),
      options.nodeExecutable,
      adapter,
    ];
    if (id === "codex")
      candidate.notes.push(
        "Uses the existing Codex model default; select a supported model when registering if that default is unavailable.",
      );
  } else if (id === "opencode") {
    command = [
      "/usr/bin/env",
      `HOME=${options.home}`,
      `XDG_CONFIG_HOME=${path.join(options.home, ".config")}`,
      `XDG_DATA_HOME=${path.join(options.home, ".local", "share")}`,
      `XDG_CACHE_HOME=${path.join(options.home, ".cache")}`,
      `XDG_STATE_HOME=${path.join(options.home, ".local", "state")}`,
      "OPENCODE_DISABLE_AUTOUPDATE=true",
      executable,
      "acp",
    ];
  } else if (id === "openclaw") {
    const bridge = path.join(options.cwd, "scripts", "launch-openclaw-acp.mjs");
    const isolatedBridge = await fileExists(bridge);
    command = [
      "/usr/bin/env",
      `OPENCLAW_STATE_DIR=${path.join(options.home, ".openclaw")}`,
      `OPENCLAW_CONFIG_PATH=${path.join(options.home, ".openclaw", "openclaw.json")}`,
      ...(isolatedBridge
        ? [options.nodeExecutable, bridge, executable]
        : [executable, "acp"]),
    ];
    candidate.notes.push(
      isolatedBridge
        ? "Uses a separate native Gateway session per Worker; bridge session recovery is not enabled."
        : "This installation may need a bridge launcher to avoid the OpenClaw ACP session-key namespace conflict.",
    );
    candidate.notes.push(
      "Requires the user's existing OpenClaw Gateway and valid model credentials.",
    );
  } else {
    throw new Error(`No managed ACP recipe for ${id}`);
  }
  candidate.notes.push(
    "Registration references the existing user configuration; executing it can update the engine's native state.",
  );
  candidate.registration = { id, driver: "acp", command, maxConcurrency: 1 };
  return candidate;
}

function fallbackDirectories(
  options: DiscoveryOptions,
  definition?: BuiltinEngine,
): string[] {
  const homeBins = [
    ".local/bin",
    ".npm-global/bin",
    ".bun/bin",
    ".volta/bin",
    "Library/pnpm",
    ".local/share/pnpm",
    ".nvm/current/bin",
    ...(definition?.homeBins ?? []),
  ];
  return [
    ...homeBins.map((directory) => path.join(options.home, directory)),
    ...(definition?.id === "pi"
      ? [path.join(options.cwd, ".tools/pi/node_modules/.bin")]
      : []),
    ...(options.systemBinDirectories ??
      (process.platform === "darwin"
        ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        : process.platform === "win32"
          ? []
          : ["/usr/local/bin", "/usr/bin", "/bin"])),
  ];
}

async function recipeCandidate(
  candidate: EngineCandidate,
  definition: BuiltinEngine,
  options: DiscoveryOptions,
  directories: string[],
): Promise<EngineCandidate> {
  const { launch } = definition;
  const env = [
    `HOME=${options.home}`,
    `XDG_CONFIG_HOME=${path.join(options.home, ".config")}`,
    `XDG_DATA_HOME=${path.join(options.home, ".local/share")}`,
    `XDG_CACHE_HOME=${path.join(options.home, ".cache")}`,
    `XDG_STATE_HOME=${path.join(options.home, ".local/state")}`,
  ];
  let command: string[];
  switch (launch.kind) {
    case "managed-acp":
      throw new Error("Managed ACP recipes must use nativeCandidate");
    case "pi-acp": {
      const localAdapter = path.join(
        options.cwd,
        ".tools/pi/node_modules/pi-acp/dist/index.js",
      );
      const adapter = await locate(
        ["pi-acp"],
        [...directories, ...fallbackDirectories(options)],
      );
      if (!adapter && !(await fileExists(localAdapter))) {
        candidate.status = "adapter-required";
        candidate.notes.push(
          "Install a pinned pi-acp adapter in .tools/pi or on PATH before ACP registration.",
        );
        return candidate;
      }
      env.push(
        `PI_ACP_PI_COMMAND=${candidate.executable}`,
        `PI_CODING_AGENT_DIR=${path.join(options.home, ".pi/agent")}`,
      );
      command = adapter ? [adapter] : [options.nodeExecutable, localAdapter];
      break;
    }
    case "acp":
      if (definition.id === "hermes")
        env.push(`HERMES_HOME=${path.join(options.home, ".hermes")}`);
      if (definition.id === "mimo")
        env.push("MIMOCODE_DISABLE_AUTOUPDATE=true");
      command = [candidate.executable, ...launch.args];
      break;
    case "cli":
      command = [candidate.executable, ...launch.args];
      candidate.notes.push(
        "Text-only CLI: each Run is independent; structured tool events, interactive permissions and session recovery are not exposed. Native permission defaults remain in effect.",
      );
      break;
  }
  // Workers isolate HOME. Keep the discovered executable's real user config and
  // interpreter lookup usable without modifying the Gateway's global environment.
  env.push(
    `PATH=${Array.from(new Set([path.dirname(candidate.executable), path.dirname(options.nodeExecutable), ...directories, ...fallbackDirectories(options, definition)])).join(path.delimiter)}`,
  );
  candidate.registration = {
    id: candidate.id,
    driver: launch.kind === "cli" ? "cli" : "acp",
    command: ["/usr/bin/env", ...env, ...command],
    maxConcurrency: 1,
    ...(launch.kind === "cli"
      ? {
          cli: {
            inputMode: launch.args.includes("{prompt}") ? "argv" : "stdin",
          } as const,
        }
      : {}),
  };
  candidate.notes.push(
    "Registration references existing user configuration; installed version, optional dependencies and authentication must be verified before relying on execution.",
  );
  return candidate;
}

async function dshCandidate(
  options: DiscoveryOptions,
  directories: string[],
): Promise<EngineCandidate | undefined> {
  const onPath = await locate(["dsh"], directories);
  const installed =
    onPath ?? (await locate(["dsh"], fallbackDirectories(options)));
  const sibling = path.resolve(
    options.cwd,
    "..",
    "deepseek-harness",
    "apps",
    "cli",
    "lib",
    "bin.js",
  );
  const executable =
    installed ?? ((await fileExists(sibling)) ? sibling : undefined);
  if (!executable) return undefined;
  const launcher = path.join(options.cwd, "scripts", "launch-dsh-acp.mjs");
  const patch = path.join(options.cwd, "engines", "dsh-local.patch.yaml");
  const usePatch =
    !installed && (await fileExists(launcher)) && (await fileExists(patch));
  const command = usePatch
    ? [
        options.nodeExecutable,
        launcher,
        executable,
        "--profile",
        "acp",
        "--patch",
        patch,
      ]
    : [
        "/usr/bin/env",
        `DSH_HOME=${path.join(options.home, ".dsh")}`,
        "DSH_TELEMETRY_DISABLED=1",
        ...(installed ? [executable] : [options.nodeExecutable, executable]),
        "--profile",
        "acp",
      ];
  return {
    id: "dsh",
    name: "DeepSeek Harness",
    executable,
    source: onPath ? "path" : "known-location",
    status: "ready",
    registration: { id: "dsh", driver: "acp", command, maxConcurrency: 1 },
    notes: [
      verificationNote,
      usePatch
        ? "Uses the existing local DSH launcher and reference patch; patch contents and credential files are not inspected by discovery."
        : "References the user's existing DSH_HOME; execution may update shared native state. Configure a private-state launcher with credential file references if needed.",
    ],
  };
}

function manifestError(message: string): HubError {
  return new HubError("INVALID_ENGINE_MANIFEST", message);
}

async function manifestCandidates(
  options: DiscoveryOptions,
  directories: string[],
): Promise<EngineCandidate[]> {
  const manifestDir = path.resolve(
    options.cwd,
    options.manifestDir ?? path.join("engines", "manifests"),
  );
  let names: string[];
  try {
    names = await readdir(manifestDir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw manifestError("The engine manifest directory cannot be read");
  }
  const result: EngineCandidate[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const file = path.join(manifestDir, name);
    const info = await lstat(file);
    if (!info.isFile() || info.size > 65_536)
      throw manifestError(
        "Manifests must be regular JSON files of at most 64 KiB",
      );
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8")) as unknown;
    } catch {
      throw manifestError(
        "An engine manifest is unreadable or is not valid JSON",
      );
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw manifestError("An engine manifest must be an object");
    const manifest = raw as Record<string, unknown>;
    if (
      Object.keys(manifest).some(
        (key) => !["name", "registration"].includes(key),
      )
    )
      throw manifestError("Unknown engine manifest field");
    if (
      manifest.name !== undefined &&
      (typeof manifest.name !== "string" || !manifest.name.trim())
    )
      throw manifestError("An engine manifest name must be a non-empty string");
    let profile;
    try {
      profile = normalizeEngine(manifest.registration);
    } catch (error) {
      if (error instanceof HubError)
        throw manifestError(
          `Invalid engine manifest registration: ${error.message}`,
        );
      throw error;
    }
    const first = profile.command?.[0];
    if (!first || profile.driver === "fake")
      throw manifestError(
        "Manifest registration requires an ACP or CLI command",
      );
    const executable =
      first.includes(path.sep) || path.isAbsolute(first)
        ? path.resolve(manifestDir, first)
        : await locate([first], directories);
    if (!executable || !(await fileExists(executable, true)))
      throw manifestError("The manifest command executable is not available");
    const registration: EngineRegistration = {
      id: profile.id,
      driver: profile.driver,
      enabled: profile.enabled,
      command: [executable, ...(profile.command?.slice(1) ?? [])],
      maxConcurrency: profile.maxConcurrency,
      ...(profile.model !== undefined ? { model: profile.model } : {}),
      ...(profile.credentialEnv !== undefined
        ? { credentialEnv: profile.credentialEnv }
        : {}),
      ...(profile.configuration !== undefined
        ? { configuration: profile.configuration }
        : {}),
      ...(profile.cli !== undefined ? { cli: profile.cli } : {}),
      ...(profile.acp !== undefined ? { acp: profile.acp } : {}),
    };
    result.push({
      id: profile.id,
      name: typeof manifest.name === "string" ? manifest.name : profile.id,
      executable,
      source: "manifest",
      status: "ready",
      registration,
      notes: [
        verificationNote,
        "Loaded from a local JSON manifest; no module was imported.",
      ],
    });
  }
  return result;
}

/**
 * Re-scan known local installations and JSON manifests without executing programs,
 * installing adapters, reading credentials or registering an engine. Paths and
 * original user configuration references appear in ready registrations. Invalid
 * manifests fail the entire scan, so partial results cannot hide configuration errors.
 */
export async function discoverEngines(
  options: DiscoveryOptions,
): Promise<EngineCandidate[]> {
  const directories = searchDirectories(options);
  const manifests =
    options.includeManifests === false
      ? []
      : await manifestCandidates(options, [
          ...directories,
          ...fallbackDirectories(options),
        ]);
  const manifestIds = new Set(manifests.map((candidate) => candidate.id));
  if (manifestIds.size !== manifests.length)
    throw manifestError("Duplicate engine IDs in local manifests");
  const candidates = await Promise.all([
    ...builtinEngines
      .filter((definition) => !manifestIds.has(definition.id))
      .map((definition) => nativeCandidate(definition, options, directories)),
    ...(manifestIds.has("dsh") ? [] : [dshCandidate(options, directories)]),
  ]);
  const result = candidates.filter((candidate) => candidate !== undefined);
  result.push(...manifests);
  return result;
}
