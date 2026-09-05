import { constants } from "node:fs";
import { access, lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { EngineCandidate, EngineRegistration } from "../domain/engines.js";
import { HubError } from "../domain/errors.js";
import { normalizeEngine } from "./registry.js";

interface DiscoveryOptions {
  cwd: string;
  home: string;
  pathEnv: string;
  nodeExecutable: string;
  manifestDir?: string;
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
  id: "codex" | "claude" | "opencode" | "openclaw",
  options: DiscoveryOptions,
  directories: string[],
): Promise<EngineCandidate | undefined> {
  const onPath = await locate([id], directories);
  const executable =
    onPath ??
    (await locate(
      [id],
      [
        path.join(options.home, ".local", "bin"),
        path.join(options.home, ".opencode", "bin"),
        path.join(options.home, ".npm-global", "bin"),
      ],
    ));
  if (!executable) return undefined;
  const candidate: EngineCandidate = {
    id,
    name: {
      codex: "Codex",
      claude: "Claude Code",
      opencode: "OpenCode",
      openclaw: "OpenClaw",
    }[id],
    executable,
    source: onPath ? "path" : "known-location",
    status: "ready",
    notes: [verificationNote],
  };
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
  } else {
    command = [
      "/usr/bin/env",
      `OPENCLAW_STATE_DIR=${path.join(options.home, ".openclaw")}`,
      `OPENCLAW_CONFIG_PATH=${path.join(options.home, ".openclaw", "openclaw.json")}`,
      executable,
      "acp",
    ];
    candidate.notes.push(
      "Requires the user's existing OpenClaw Gateway and valid model credentials.",
    );
  }
  candidate.notes.push(
    "Registration references the existing user configuration; executing it can update the engine's native state.",
  );
  candidate.registration = { id, driver: "acp", command, maxConcurrency: 1 };
  return candidate;
}

async function dshCandidate(
  options: DiscoveryOptions,
  directories: string[],
): Promise<EngineCandidate | undefined> {
  const onPath = await locate(["dsh"], directories);
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
    onPath ?? ((await fileExists(sibling)) ? sibling : undefined);
  if (!executable) return undefined;
  const launcher = path.join(options.cwd, "scripts", "launch-dsh-acp.mjs");
  const patch = path.join(options.cwd, "engines", "dsh-local.patch.yaml");
  const usePatch =
    !onPath && (await fileExists(launcher)) && (await fileExists(patch));
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
        ...(onPath ? [executable] : [options.nodeExecutable, executable]),
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
      ...(profile.cli !== undefined ? { cli: profile.cli } : {}),
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
  const candidates = await Promise.all([
    ...(["codex", "claude", "opencode", "openclaw"] as const).map((id) =>
      nativeCandidate(id, options, directories),
    ),
    dshCandidate(options, directories),
  ]);
  const result = candidates.filter((candidate) => candidate !== undefined);
  result.push(...(await manifestCandidates(options, directories)));
  if (new Set(result.map((candidate) => candidate.id)).size !== result.length)
    throw manifestError(
      "Duplicate engine IDs in discovery candidates; use a distinct manifest ID",
    );
  return result;
}
