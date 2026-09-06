import { Ajv } from "ajv";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  engineConfigurationSchema,
  type SecretReference,
} from "../domain/engine-configuration.js";
import type { EngineRegistration } from "../domain/engines.js";
import type { BundleContext, BundleManifest, BundleSettings } from "./types.js";
import { bundlePath } from "./manifest.js";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion"],
  properties: {
    schemaVersion: { const: 1 },
    defaultEngine: { type: "string", minLength: 1 },
    modelProfiles: {
      type: "object",
      maxProperties: 32,
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["model", "provider"],
        properties: {
          model: { type: "string", minLength: 1 },
          provider: engineConfigurationSchema.properties.provider,
        },
      },
    },
    engines: {
      type: "object",
      maxProperties: 64,
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          modelProfile: { type: "string", minLength: 1 },
          model: { type: "string", minLength: 1 },
          configuration: engineConfigurationSchema,
          toolPackages: {
            type: "array",
            maxItems: 16,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "version"],
              properties: {
                id: { type: "string", minLength: 1 },
                version: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
  },
} as const;
const validate = new Ajv({ allErrors: true }).compile<BundleSettings>(schema);

/** Settings store model names and existing secret references, never inline API values. */
export function parseSettings(input: unknown): BundleSettings {
  if (!validate(input))
    throw new Error(
      `Invalid release settings: ${new Ajv().errorsText(validate.errors)}`,
    );
  const reference = (ref: SecretReference) => {
    if (ref.kind === "env" && !/^[A-Z][A-Z0-9_]*$/.test(ref.value))
      throw new Error("Secret env reference must name a variable");
    if (
      ref.kind === "file" &&
      !path.isAbsolute(ref.value) &&
      !path.win32.isAbsolute(ref.value)
    )
      throw new Error("Secret file reference must be absolute");
    if (ref.kind === "keychain" && !/^[a-f0-9-]{36}$/.test(ref.value))
      throw new Error("Invalid system secret reference");
  };
  const configurations = [
    ...Object.values(input.modelProfiles ?? {}).map((profile) => ({
      provider: profile.provider,
    })),
    ...Object.values(input.engines ?? {}).flatMap((engine) =>
      engine.configuration ? [engine.configuration] : [],
    ),
  ];
  const environment = (values: Record<string, string> | undefined) => {
    for (const [name, value] of Object.entries(values ?? {}))
      if (
        /KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|COOKIE/i.test(name) ||
        value.includes("\0") ||
        /\b(?:sk-|ghp_|Bearer )[a-zA-Z0-9_-]{12,}/.test(value)
      )
        throw new Error("Environment credentials require secret references");
  };
  for (const config of configurations) {
    if (config.provider?.baseUrl) {
      const url = new URL(config.provider.baseUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          "Provider URL must be HTTP(S), without credentials, query or fragment",
        );
    }
    if (config.provider?.apiKey) reference(config.provider.apiKey);
    if ("env" in config) environment(config.env);
    if ("secretEnv" in config)
      for (const ref of Object.values(config.secretEnv ?? {})) reference(ref);
    if ("mcpServers" in config)
      for (const server of config.mcpServers ?? []) {
        environment(server.env);
        environment(server.headers);
        for (const ref of Object.values({
          ...server.secretEnv,
          ...server.secretHeaders,
        }))
          reference(ref);
      }
  }
  return input;
}
export async function readSettings(state: string): Promise<BundleSettings> {
  try {
    return parseSettings(
      JSON.parse(
        await readFile(path.join(state, "settings.json"), "utf8"),
      ) as unknown,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { schemaVersion: 1 };
    throw error;
  }
}
/** Atomic settings replacement never destroys the previous version on validation/write failure. */
export async function writeSettings(
  state: string,
  settings: BundleSettings,
): Promise<void> {
  parseSettings(settings);
  await mkdir(state, { recursive: true, mode: 0o700 });
  const target = path.join(state, "settings.json");
  const temporary = path.join(state, `settings.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, target);
}
function expand(value: string, anchors: Record<string, string>): string {
  for (const match of value.matchAll(
    /\$\{(bundle|state|home|workspace)\}([^$]*)/g,
  )) {
    const suffix = match[2]!;
    if (suffix && (!suffix.startsWith("/") || suffix === "/"))
      throw new Error(
        "Anchored bundle paths require an explicit relative suffix",
      );
    if (suffix) bundlePath(anchors[match[1]!]!, suffix.slice(1));
  }
  return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
    if (!Object.hasOwn(anchors, key))
      throw new Error(`Unknown release path anchor: ${key}`);
    const replacement = anchors[key];
    if (replacement === undefined)
      throw new Error(`Unknown release path anchor: ${key}`);
    return replacement;
  });
}
/** Materialize a fresh root into ordinary Engine registrations, preserving the shared Runtime contract. */
export function materializeEngines(
  manifest: BundleManifest,
  settings: BundleSettings,
  context: BundleContext,
): EngineRegistration[] {
  const known = new Set(manifest.engines.map((engine) => engine.id));
  for (const id of Object.keys(settings.engines ?? {}))
    if (!known.has(id))
      throw new Error(`Settings refer to an engine outside this bundle: ${id}`);
  if (settings.defaultEngine && !known.has(settings.defaultEngine))
    throw new Error("Default engine is not in this bundle");
  if (
    !manifest.engines.some(
      (engine) => settings.engines?.[engine.id]?.enabled !== false,
    )
  )
    throw new Error("At least one bundled engine must remain enabled");
  if (
    settings.defaultEngine &&
    settings.engines?.[settings.defaultEngine]?.enabled === false
  )
    throw new Error("Default engine must be enabled");
  return manifest.engines.map((engine) => {
    const selected = settings.engines?.[engine.id];
    const home = path.join(context.state, "engine-homes", engine.id);
    const anchors = {
      bundle: context.root,
      node: context.node,
      state: context.state,
      workspace: context.workspace,
      home,
    };
    const env = Object.fromEntries(
      Object.entries(engine.env ?? {}).map(([name, value]) => [
        name,
        expand(value, anchors),
      ]),
    );
    if (
      Object.keys(env).some((name) =>
        /^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PATH|NODE_PATH|NODE_OPTIONS|PYTHONHOME|PYTHONPATH|XDG_.*)$/i.test(
          name,
        ),
      )
    )
      throw new Error("Bundled engine cannot override private process roots");
    if (!(
      engine.command[0] === "${node}" ||
      engine.command[0]?.startsWith("${bundle}/")
    ))
      throw new Error(
        "Bundled executable must use the bundled Node or a bundle-relative path",
      );
    const paths = [
      path.dirname(context.node),
      path.join(context.root, "bin"),
      path.join(
        context.root,
        "bin",
        "git",
        manifest.arch === "arm64" ? "clangarm64" : "mingw64",
        "bin",
      ),
      path.join(context.root, "bin", "git", "cmd"),
      path.join(context.root, "bin", "git", "usr", "bin"),
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
      process.env.SystemRoot ?? "C:\\Windows",
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
      ),
    ];
    const privateEnv = {
      PATH: paths.join(path.delimiter),
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      ...env,
    };
    const registration: EngineRegistration = {
      id: engine.id,
      driver: engine.driver,
      maxConcurrency: 1,
      enabled: selected?.enabled ?? true,
      command: [
        context.node,
        bundlePath(context.root, "scripts/launch-engine.mjs"),
        ...Object.entries(privateEnv).map(
          ([name, value]) => `${name}=${value}`,
        ),
        "--",
        ...engine.command.map((arg) => expand(arg, anchors)),
      ],
      configuration: {
        adapter: "generic",
        ...engine.configuration,
        ...selected?.configuration,
      },
      ...(engine.credentialEnv ? { credentialEnv: engine.credentialEnv } : {}),
      ...(engine.cli ? { cli: engine.cli } : {}),
      ...(engine.acp ? { acp: engine.acp } : {}),
    };
    if (selected?.modelProfile) {
      const profile =
        settings.modelProfiles &&
        Object.hasOwn(settings.modelProfiles, selected.modelProfile)
          ? settings.modelProfiles[selected.modelProfile]
          : undefined;
      if (!profile)
        throw new Error(`Missing model profile: ${selected.modelProfile}`);
      if (selected.model || selected.configuration?.provider)
        throw new Error(
          `Engine ${engine.id} has conflicting model/provider sources`,
        );
      registration.model = profile.model;
      registration.configuration!.provider = profile.provider;
    } else if (selected?.model) registration.model = selected.model;
    return registration;
  });
}
/** Prepare private state directories before any engine runs; no personal home/config is imported. */
export async function prepareDirectories(
  context: BundleContext,
  manifest: BundleManifest,
) {
  await mkdir(context.workspace, { recursive: true });
  await mkdir(context.state, { recursive: true, mode: 0o700 });
  for (const engine of manifest.engines) {
    const home = path.join(context.state, "engine-homes", engine.id);
    for (const relative of [
      "",
      "AppData/Roaming",
      "AppData/Local",
      ".config",
      ".cache",
      ".local/share",
    ])
      await mkdir(path.join(home, relative), { recursive: true, mode: 0o700 });
    for (const [name, value] of Object.entries(engine.env ?? {}))
      if (/(?:_HOME|_DIR)$/.test(name) && value.startsWith("${home}/"))
        await mkdir(bundlePath(home, value.slice("${home}/".length)), {
          recursive: true,
          mode: 0o700,
        });
  }
}
