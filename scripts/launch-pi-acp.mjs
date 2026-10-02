/** Launch pinned Pi/ACP binaries with credentials read from an existing DSH reference file. */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";

class LaunchError extends Error {}
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

async function main() {
  const [adapterEntry, piExecutable, settingsPath, credentialsPath, ...extra] =
    process.argv.slice(2);
  if (
    extra.length ||
    ![adapterEntry, piExecutable, settingsPath, credentialsPath].every(
      (value) => typeof value === "string" && isAbsolute(value),
    )
  )
    throw new LaunchError(
      "Usage: node launch-pi-acp.mjs <absolute adapter entry> <absolute pi executable> <absolute DSH settings> <absolute DSH credentials>",
    );
  const privateHome = process.env.HOME;
  if (
    !privateHome ||
    !isAbsolute(privateHome) ||
    resolve(privateHome) === resolve(userInfo().homedir)
  )
    throw new LaunchError("Pi launcher requires a Worker-owned private HOME");
  const settings = parse(await readFile(settingsPath, "utf8"));
  const model = object(settings) ? settings["agent-default-model"] : undefined;
  if (
    !object(model) ||
    model.provider !== "deepseek-official" ||
    typeof model.model !== "string" ||
    !model.model ||
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      model.reasoningEffort,
    )
  )
    throw new LaunchError(
      "DSH default must select DeepSeek with an explicit supported thinking level",
    );
  const credentials = parse(await readFile(credentialsPath, "utf8"));
  const key =
    object(credentials) && object(credentials.refs)
      ? credentials.refs.DEEPSEEK_API_KEY
      : undefined;
  if (typeof key !== "string" || !key.trim())
    throw new LaunchError(
      "DSH credentials do not contain a DeepSeek API key reference",
    );
  const agentDir = join(privateHome, ".pi", "agent");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  // This private file contains model preferences only. The secret remains in child memory.
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "deepseek",
        defaultModel: model.model,
        defaultThinkingLevel: model.reasoningEffort,
        quietStartup: true,
        enableInstallTelemetry: false,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const child = spawn(process.execPath, [adapterEntry], {
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: [dirname(process.execPath), dirname(piExecutable), process.env.PATH]
        .filter(Boolean)
        .join(delimiter),
      PI_ACP_PI_COMMAND: piExecutable,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SKIP_VERSION_CHECK: "1",
      PI_OFFLINE: "1",
      DEEPSEEK_API_KEY: key,
    },
  });
  const forwardInt = () => child.kill("SIGINT");
  const forwardTerm = () => child.kill("SIGTERM");
  process.on("SIGINT", forwardInt);
  process.on("SIGTERM", forwardTerm);
  try {
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolveExit(code ?? 1));
    });
  } finally {
    process.off("SIGINT", forwardInt);
    process.off("SIGTERM", forwardTerm);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof LaunchError ? error.message : "Pi launcher could not initialize its local configuration"}\n`,
  );
  process.exitCode = 1;
}
