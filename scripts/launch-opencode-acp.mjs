/** Launch installed OpenCode with a private HOME and an existing DSH DeepSeek credential reference. */
import { spawnEngine as spawn } from "./spawn-engine.mjs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";

class LaunchError extends Error {}
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

async function main() {
  const [
    executable,
    settingsPath,
    credentialsPath,
    dependencySeed,
    modelsPath,
    mode,
    ...extra
  ] = process.argv.slice(2);
  if (
    extra.length ||
    ![
      executable,
      settingsPath,
      credentialsPath,
      dependencySeed,
      modelsPath,
    ].every((value) => typeof value === "string" && isAbsolute(value)) ||
    (mode !== undefined && mode !== "--check-config")
  )
    throw new LaunchError(
      "Usage: node launch-opencode-acp.mjs <absolute OpenCode executable> <DSH settings> <DSH credentials> <installed OpenCode config dependency directory> <cached models.json> [--check-config]",
    );
  const privateHome = process.env.HOME;
  if (
    !privateHome ||
    !isAbsolute(privateHome) ||
    resolve(privateHome) === resolve(userInfo().homedir)
  )
    throw new LaunchError(
      "OpenCode launcher requires a Worker-owned private HOME",
    );
  const settings = parse(await readFile(settingsPath, "utf8"));
  const selection = object(settings)
    ? settings["agent-default-model"]
    : undefined;
  if (
    !object(selection) ||
    selection.provider !== "deepseek-official" ||
    selection.model !== "deepseek-v4-flash" ||
    selection.reasoningEffort !== "max"
  )
    throw new LaunchError(
      "This profile requires the existing DeepSeek v4 Flash model with explicit max reasoning",
    );
  const installedPlugin = JSON.parse(
    await readFile(
      join(dependencySeed, "node_modules/@opencode-ai/plugin/package.json"),
      "utf8",
    ),
  );
  const seedManifest = JSON.parse(
    await readFile(join(dependencySeed, "package.json"), "utf8"),
  );
  if (
    installedPlugin.version !== "1.1.21" ||
    JSON.stringify(seedManifest) !==
      JSON.stringify({ dependencies: { "@opencode-ai/plugin": "1.1.21" } })
  )
    throw new LaunchError(
      "OpenCode 1.1.21 requires its existing pinned plugin dependency seed",
    );
  const modelsBytes = await readFile(modelsPath);
  const models = JSON.parse(modelsBytes.toString("utf8"));
  const metadata = models?.deepseek?.models?.[selection.model];
  if (
    !object(metadata) ||
    !object(metadata.limit) ||
    !Number.isSafeInteger(metadata.limit.context) ||
    !Number.isSafeInteger(metadata.limit.output) ||
    metadata.limit.context <= 0 ||
    metadata.limit.output <= 0 ||
    metadata.interleaved?.field !== "reasoning_content"
  )
    throw new LaunchError(
      "Cached DeepSeek model metadata is missing; do not guess token limits or reasoning transport",
    );
  const configRoot = join(privateHome, ".config", "opencode");
  const cacheRoot = join(privateHome, ".cache", "opencode");
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  for (const name of ["package.json", "bun.lock", "node_modules"])
    await cp(join(dependencySeed, name), join(configRoot, name), {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  // This old OpenCode release always invokes bun add/install. Existing dependencies are copied,
  // while a loopback-only registry prevents remote package resolution in this private directory.
  await writeFile(
    join(configRoot, "bunfig.toml"),
    '[install]\nregistry = "http://127.0.0.1:9"\nfrozenLockfile = true\n',
    { mode: 0o600 },
  );
  await writeFile(join(cacheRoot, "models.json"), modelsBytes, { mode: 0o600 });
  await writeFile(join(cacheRoot, "version"), "18", { mode: 0o600 });
  const config = {
    autoupdate: false,
    share: "disabled",
    enabled_providers: ["deepseek"],
    model: `deepseek/${selection.model}`,
    small_model: `deepseek/${selection.model}`,
    plugin: [],
    mcp: {},
    formatter: false,
    lsp: false,
    permission: {
      edit: "ask",
      bash: "ask",
      webfetch: "deny",
      external_directory: "deny",
    },
    provider: {
      deepseek: {
        npm: "@ai-sdk/openai-compatible",
        env: ["DEEPSEEK_API_KEY"],
        whitelist: [selection.model],
        options: { baseURL: "https://api.deepseek.com", includeUsage: true },
        models: {
          [selection.model]: {
            name: "DeepSeek V4 Flash",
            reasoning: true,
            tool_call: true,
            limit: metadata.limit,
            interleaved: { field: "reasoning_content" },
            options: {
              thinking: { type: "enabled" },
              reasoningEffort: selection.reasoningEffort,
            },
          },
        },
      },
    },
  };
  const credentials = parse(await readFile(credentialsPath, "utf8"));
  const key =
    object(credentials) && object(credentials.refs)
      ? credentials.refs.DEEPSEEK_API_KEY
      : undefined;
  if (typeof key !== "string" || !key.trim())
    throw new LaunchError(
      "The existing DSH reference does not contain a DeepSeek API key",
    );
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(privateHome, ".config"),
    XDG_CACHE_HOME: join(privateHome, ".cache"),
    XDG_DATA_HOME: join(privateHome, ".local", "share"),
    XDG_STATE_HOME: join(privateHome, ".local", "state"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
    NPM_CONFIG_REGISTRY: "http://127.0.0.1:9",
    npm_config_registry: "http://127.0.0.1:9",
    DEEPSEEK_API_KEY: key,
  };
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_DIR;
  const checking = mode === "--check-config";
  const child = spawn(executable, checking ? ["debug", "config"] : ["acp"], {
    stdio: checking ? ["ignore", "pipe", "pipe"] : "inherit",
    env,
  });
  let output = "";
  if (checking) {
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.resume();
  }
  const forwardInt = () => child.kill("SIGINT");
  const forwardTerm = () => child.kill("SIGTERM");
  process.on("SIGINT", forwardInt);
  process.on("SIGTERM", forwardTerm);
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (status) => resolveExit(status ?? 1));
    });
    if (checking && code === 0) {
      const resolved = JSON.parse(output);
      if (
        resolved.model !== config.model ||
        resolved.provider?.deepseek?.models?.[selection.model]?.options
          ?.reasoningEffort !== "max"
      )
        throw new LaunchError(
          "Resolved OpenCode model configuration did not preserve the selected model and reasoning",
        );
      process.stdout.write(
        `${JSON.stringify({ model: resolved.model, smallModel: resolved.small_model, reasoningEffort: "max", thinking: "enabled", pluginVersion: installedPlugin.version, isolatedHome: true, remotePackageRegistry: false, modelCalls: 0 })}\n`,
      );
    }
    process.exitCode = code;
  } finally {
    process.off("SIGINT", forwardInt);
    process.off("SIGTERM", forwardTerm);
  }
}
try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof LaunchError ? error.message : "OpenCode launcher could not initialize its isolated configuration"}\n`,
  );
  process.exitCode = 1;
}
