import path from "node:path";
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { startHub } from "./main.js";
import { prepareEngine } from "./engine/registry.js";
import { bundlePath, readBundle } from "./distribution/manifest.js";
import {
  materializeEngines,
  prepareDirectories,
  readSettings,
} from "./distribution/configuration.js";
import {
  applyFullAccessToRegistration,
  fullAccessEnabled,
} from "./distribution/full-access.js";
import type {
  BundleContext,
  BundleManifest,
  BundleSettings,
} from "./distribution/types.js";
import type { EngineRegistration } from "./domain/engines.js";
import type { EngineProfile } from "./domain/types.js";
import { bindInstalled } from "./tool-packages/index.js";

const help = [
  "gateway.cmd (or Start-Competition.cmd) --engine <id> [options]",
  "  --engine <id>          Engine used by every Competition /session (or AGENT_ENGINE)",
  "  --port <6217>          Competition API port",
  "  --host <localhost>     Competition API host",
  "  --console-port <3330>  Bundled console on 127.0.0.1; a busy port falls back to a free one",
  "  --no-console           Start only the competition Gateway",
  "  --open                 Open the console in the default browser once it is ready",
  "  --full-access          Auto-approve engine tool requests (gateway.cmd default)",
  "  --safe-permissions     Keep normal permission prompts and denials",
  "Opening the Gateway root / redirects to the console. The console never blocks or stops the Gateway.",
].join("\n");

/** Default loopback port of the bundled console, shared with `hub.cmd start`. */
export const DEFAULT_CONSOLE_PORT = 3330;

/** Where the bundled console listens; `reason` explains a fallback away from `requested`. */
export interface ConsolePortChoice {
  port: number;
  requested: number;
  reason?: "in-use" | "gateway-port";
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1" }, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
async function release(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
async function listenable(port: number): Promise<boolean> {
  const server = createServer();
  try {
    await listen(server, port);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "EADDRINUSE" || error.code === "EACCES")
    )
      return false;
    throw error;
  }
  await release(server);
  return true;
}
async function ephemeralPort(): Promise<number> {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  await release(server);
  if (!address || typeof address === "string")
    throw new Error("Could not reserve a loopback port for the console");
  return address.port;
}
/**
 * Choose the console port on 127.0.0.1, the address the console binds. A busy port, or one
 * equal to the Gateway port, falls back to an OS-assigned free port so the console can never
 * prevent the competition Gateway from starting. The probe releases the port before returning;
 * a process that takes it before the console binds surfaces as a `console.exited` event.
 */
export async function chooseConsolePort(
  requested: number,
  gatewayPort: number,
): Promise<ConsolePortChoice> {
  if (requested !== gatewayPort && (await listenable(requested)))
    return { port: requested, requested };
  let port = await ephemeralPort();
  while (port === gatewayPort) port = await ephemeralPort();
  return {
    port,
    requested,
    reason: requested === gatewayPort ? "gateway-port" : "in-use",
  };
}
/** Loopback URL the console proxy uses to reach the competition Gateway listener. */
export function consoleGatewayUrl(host: string, port: number): string {
  return /^\[?::1\]?$/.test(host)
    ? `http://[::1]:${port}`
    : `http://127.0.0.1:${port}`;
}
/**
 * Console process environment: Windows system variables, a PATH of the bundled runtime and
 * System32 only, and the listener/upstream settings. Model credentials and engine variables of
 * the Gateway process are deliberately not inherited; the console only proxies loopback HTTP.
 */
export function consoleEnvironment(
  source: NodeJS.ProcessEnv,
  options: { node: string; port: number; gatewayUrl: string },
): NodeJS.ProcessEnv {
  const system: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source))
    if (
      value !== undefined &&
      /^(?:SystemRoot|WINDIR|COMSPEC|TEMP|TMP)$/i.test(name)
    )
      system[name] = value;
  const windows = source.SystemRoot ?? source.SYSTEMROOT ?? "C:\\Windows";
  return {
    ...system,
    PATH: [path.dirname(options.node), path.join(windows, "System32")].join(
      path.delimiter,
    ),
    PORT: String(options.port),
    HOSTNAME: "127.0.0.1",
    HARNESSHUB_GATEWAY_URL: options.gatewayUrl,
    NEXT_TELEMETRY_DISABLED: "1",
  };
}
/** A started console process. `terminate` requests the whole console tree to stop. */
export interface LaunchedConsole {
  child: ChildProcessByStdio<null, Readable, Readable>;
  terminate(): Promise<void>;
}
export type ConsoleLauncher = (
  entry: string,
  env: NodeJS.ProcessEnv,
) => LaunchedConsole;
/**
 * Production launcher: the bundled Job Object helper owns the console tree and empties it when
 * this Gateway process exits for any reason; `close <token>` empties it on an orderly shutdown.
 */
export function jobConsoleLauncher(
  helper: string,
  node: string,
): ConsoleLauncher {
  return (entry, env) => {
    const token = randomUUID();
    const child = spawn(
      helper,
      ["run", String(process.pid), token, node, entry],
      {
        cwd: path.dirname(entry),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    return {
      child,
      terminate: async () => {
        await promisify(execFile)(helper, ["close", token, "5000"], {
          timeout: 6000,
          windowsHide: true,
        });
      },
    };
  };
}
export interface SupervisedConsole {
  readonly url: string;
  /**
   * Settles true once the console proxies `/api/gateway/health/live` to the Gateway, and
   * false when the console exits, is stopped, or the startup budget passes first. Never rejects.
   */
  readonly ready: Promise<boolean>;
  /** Idempotent: terminate the console tree and wait until the launcher process has exited. */
  stop(): Promise<void>;
}
export interface ConsoleSupervisorOptions {
  url: string;
  entry: string;
  env: NodeJS.ProcessEnv;
  launch: ConsoleLauncher;
  /** Structured lifecycle events such as `console.ready` and `console.exited`. */
  emit: (event: Record<string, unknown>) => void;
  /** One line of console process output, forwarded verbatim. */
  output: (line: string) => void;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
}
function forwardLines(stream: Readable, output: (line: string) => void) {
  stream.setEncoding("utf8");
  let pending = "";
  stream.on("data", (chunk: string) => {
    pending += chunk;
    for (
      let index = pending.indexOf("\n");
      index >= 0;
      index = pending.indexOf("\n")
    ) {
      const line = pending.slice(0, index).replace(/\r$/, "");
      pending = pending.slice(index + 1);
      if (line) output(line);
    }
    if (pending.length > 16_384) {
      output(pending);
      pending = "";
    }
  });
  stream.once("end", () => {
    if (pending) output(pending);
    pending = "";
  });
  // A broken pipe only loses console log lines; it must never become a Gateway exception.
  stream.on("error", (error) =>
    output(`console output error: ${error.message}`),
  );
}
/**
 * Start the console and own it until `stop`. Every console failure (spawn error, crash, slow
 * start) is reported through `emit` and never thrown, so the competition Gateway keeps serving.
 */
export function superviseConsole(
  options: ConsoleSupervisorOptions,
): SupervisedConsole {
  const launched = options.launch(options.entry, options.env);
  const { child } = launched;
  let stopping = false;
  let exited = false;
  let spawnFailed = false;
  const closed = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      exited = true;
      if (!stopping && !spawnFailed)
        options.emit({
          event: "console.exited",
          code,
          signal,
          gateway: "running",
        });
      resolve();
    });
    child.once("error", (error) => {
      options.emit({ event: "console.error", message: error.message });
      // A process that never started has nothing left to wait for, whether or not "close" follows.
      if (child.pid === undefined) {
        spawnFailed = true;
        exited = true;
        resolve();
      }
    });
  });
  forwardLines(child.stdout, options.output);
  forwardLines(child.stderr, options.output);
  const ready = (async () => {
    const until = Date.now() + (options.readyTimeoutMs ?? 60_000);
    const probe = new URL("/api/gateway/health/live", options.url);
    while (!stopping && !exited && Date.now() < until) {
      try {
        const response = await fetch(probe, {
          signal: AbortSignal.timeout(2000),
        });
        const body: unknown = await response.json().catch(() => undefined);
        if (
          response.ok &&
          typeof body === "object" &&
          body !== null &&
          "status" in body &&
          body.status === "ok"
        ) {
          options.emit({ event: "console.ready", url: options.url });
          return true;
        }
      } catch {
        // Not listening yet; retry until the budget passes or the process exits.
      }
      await Promise.race([delay(250), closed]);
    }
    if (!stopping && !exited)
      options.emit({
        event: "console.unready",
        url: options.url,
        message: "The console did not answer before the startup budget",
      });
    return false;
  })();
  let stopped: Promise<void> | undefined;
  return {
    url: options.url,
    ready,
    stop() {
      stopped ??= (async () => {
        stopping = true;
        if (!exited) {
          try {
            await launched.terminate();
          } catch (error) {
            options.emit({
              event: "console.cleanup-failed",
              message: error instanceof Error ? error.message : String(error),
            });
          }
          // Killing the Job helper closes its Job handle, which terminates the console tree.
          const timer = setTimeout(
            () => child.kill("SIGKILL"),
            options.stopTimeoutMs ?? 5000,
          );
          try {
            await closed;
          } finally {
            clearTimeout(timer);
          }
        }
        await ready;
      })();
      return stopped;
    },
  };
}
/** Opens the console in the default browser; failures are reported, never thrown. */
function openBrowser(
  url: string,
  emit: (event: Record<string, unknown>) => void,
): void {
  // Only a generated loopback URL reaches cmd.exe, so no shell metacharacters are possible.
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d{1,5}$/.test(url)) {
    emit({ event: "console.open-failed", message: "Unexpected console URL" });
    return;
  }
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  const opener = spawn(
    path.join(windows, "System32", "cmd.exe"),
    ["/d", "/c", "start", '""', url],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true,
    },
  );
  opener.once("error", (error) =>
    emit({ event: "console.open-failed", message: error.message }),
  );
  opener.unref();
}
function printEvent(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event));
}
interface ConsolePlan {
  entry: string;
  helper: string;
  port: number;
  url: string;
}
/** Resolve bundle files and the port; a missing console never blocks the competition Gateway. */
async function planConsole(
  root: string,
  manifest: BundleManifest,
  requested: number,
  gatewayPort: number,
): Promise<ConsolePlan | undefined> {
  const entry = bundlePath(root, manifest.consoleEntry);
  const helper = bundlePath(root, "dist/native/harnesshub-job.exe");
  for (const file of [entry, helper]) {
    const info = await lstat(file).catch(() => undefined);
    if (!info?.isFile()) {
      printEvent({
        event: "console.unavailable",
        message: `Bundled console file is missing: ${path.relative(root, file)}`,
      });
      return undefined;
    }
  }
  const choice = await chooseConsolePort(requested, gatewayPort);
  if (choice.reason) {
    printEvent({
      event: "console.port-fallback",
      requestedPort: choice.requested,
      port: choice.port,
      reason: choice.reason,
    });
    process.stderr.write(
      `Console port ${choice.requested} is ${choice.reason === "in-use" ? "in use" : "the Gateway port"}; using ${choice.port} instead\n`,
    );
  }
  return {
    entry,
    helper,
    port: choice.port,
    url: `http://127.0.0.1:${choice.port}`,
  };
}

function registration(profile: EngineProfile): EngineRegistration {
  const {
    revision: _revision,
    capabilities: _capabilities,
    ...value
  } = profile;
  if (value.driver === "fake" || !value.command)
    throw new Error("A real bundled engine is required");
  return { ...value, driver: value.driver, command: value.command };
}

async function profiles(
  manifest: BundleManifest,
  settings: BundleSettings,
  context: BundleContext,
): Promise<EngineRegistration[]> {
  const result: EngineRegistration[] = [];
  for (const materialized of materializeEngines(manifest, settings, context)) {
    const engine = applyFullAccessToRegistration(materialized);
    for (const selected of settings.engines?.[engine.id]?.toolPackages ?? []) {
      const binding = await bindInstalled(
        path.join(context.state, "tool-packages"),
        selected.id,
        selected.version,
        {
          nodeExecutable: context.node,
          workspace: context.workspace,
        },
      );
      engine.configuration = {
        adapter: "generic",
        ...engine.configuration,
        skills: [...(engine.configuration?.skills ?? []), ...binding.skills],
        mcpServers: [
          ...(engine.configuration?.mcpServers ?? []),
          ...binding.mcpServers,
        ],
      };
    }
    result.push(registration(await prepareEngine(engine)));
  }
  return result;
}

async function generatedConfig(
  manifest: BundleManifest,
  settings: BundleSettings,
  context: BundleContext,
): Promise<{ file: string; engines: EngineRegistration[] }> {
  const engines = await profiles(manifest, settings, context);
  const target = path.join(context.state, "engines.competition.json");
  const enabled = engines.filter((engine) => engine.enabled !== false);
  const defaultEngine =
    settings.defaultEngine ??
    enabled.find((engine) => engine.id === "opencode")?.id ??
    enabled.find((engine) => engine.id === "codex")?.id ??
    enabled[0]?.id;
  if (!defaultEngine || !enabled.some((engine) => engine.id === defaultEngine))
    throw new Error("Bundle has no enabled engine");
  await writeFile(
    target,
    `${JSON.stringify(
      {
        engines,
        workspaces: [{ id: "default", path: context.workspace }],
        defaultWorkspace: "default",
        defaultEngine,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { file: target, engines };
}

function applyPrivateEnvironment(context: BundleContext): void {
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  for (const name of Object.keys(process.env))
    if (
      /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|NODE_PATH|NODE_OPTIONS|PYTHONPATH|PYTHONHOME|XDG_.*)$/i.test(
        name,
      )
    )
      delete process.env[name];
  const home = path.join(context.state, "gateway-home");
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    PATH: [
      path.dirname(context.node),
      path.join(context.root, "bin"),
      path.join(
        context.root,
        "bin",
        "git",
        process.arch === "arm64" ? "clangarm64" : "mingw64",
        "bin",
      ),
      path.join(context.root, "bin", "git", "cmd"),
      path.join(context.root, "bin", "git", "usr", "bin"),
      path.join(windows, "System32"),
      windows,
      path.join(windows, "System32", "WindowsPowerShell", "v1.0"),
    ].join(path.delimiter),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  });
}

export async function competitionBundleMain(
  args: string[],
  bundleRoot = fileURLToPath(new URL("../../", import.meta.url)),
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      engine: { type: "string" },
      port: { type: "string", default: "6217" },
      host: { type: "string", default: "localhost" },
      "console-port": { type: "string" },
      "no-console": { type: "boolean", default: false },
      open: { type: "boolean", default: false },
      "full-access": { type: "boolean", default: false },
      "safe-permissions": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  if (values["full-access"] && values["safe-permissions"])
    throw new Error("Choose either --full-access or --safe-permissions");
  const consoleEnabled = !values["no-console"];
  if (!consoleEnabled && (values["console-port"] !== undefined || values.open))
    throw new Error(
      "--console-port and --open need the console; remove --no-console",
    );
  const consolePort = Number(values["console-port"] ?? DEFAULT_CONSOLE_PORT);
  if (!Number.isInteger(consolePort) || consolePort <= 0 || consolePort > 65535)
    throw new Error("Console port must be between 1 and 65535");
  if (values["full-access"]) process.env.HARNESSHUB_FULL_ACCESS = "1";
  if (values["safe-permissions"]) delete process.env.HARNESSHUB_FULL_ACCESS;

  const engineId = values.engine ?? process.env.AGENT_ENGINE;
  if (!engineId)
    throw new Error("Competition bundle requires --engine or AGENT_ENGINE");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    throw new Error("Competition port must be between 1 and 65535");

  const root = path.resolve(bundleRoot);
  const manifest = await readBundle(root);
  if (
    process.platform !== manifest.platform ||
    process.arch !== manifest.arch ||
    process.versions.node !== manifest.nodeVersion
  )
    throw new Error(
      `This bundle requires ${manifest.platform}/${manifest.arch} Node ${manifest.nodeVersion}; use Start-Competition.cmd from the bundle`,
    );
  const context: BundleContext = {
    root,
    state: path.join(root, "state"),
    workspace: path.join(root, "state", "workspace"),
    node: bundlePath(root, "runtime/node.exe"),
  };
  await prepareDirectories(context, manifest);
  await mkdir(path.join(context.state, "gateway-home"), {
    recursive: true,
    mode: 0o700,
  });
  const settings = await readSettings(context.state);
  const generated = await generatedConfig(manifest, settings, context);
  const selected = generated.engines.find((engine) => engine.id === engineId);
  if (!selected)
    throw new Error(`Engine ${engineId} is not included in this bundle`);
  if (selected.enabled === false)
    throw new Error(
      `Engine ${engineId} is disabled in state/settings.json; configure it before starting the competition gateway`,
    );

  applyPrivateEnvironment(context);
  const plan = consoleEnabled
    ? await planConsole(root, manifest, consolePort, port)
    : undefined;
  const hub = await startHub({
    dataDir: path.join(context.state, "competition-data"),
    configFile: generated.file,
    demo: false,
    competition: true,
    defaultEngine: engineId,
    competitionEngine: engineId,
    toolPackageRoot: path.join(context.state, "tool-packages"),
    harnessModelFile: path.join(context.state, "harness-model.json"),
    cwd: context.workspace,
    port,
    host: values.host,
    ...(plan ? { consoleUrl: plan.url } : {}),
  });
  // Started after the Gateway listens, so the console proxy has an upstream from its first request.
  let bundledConsole: SupervisedConsole | undefined;
  if (plan) {
    try {
      bundledConsole = superviseConsole({
        url: plan.url,
        entry: plan.entry,
        env: consoleEnvironment(process.env, {
          node: context.node,
          port: plan.port,
          gatewayUrl: consoleGatewayUrl(values.host, port),
        }),
        launch: jobConsoleLauncher(plan.helper, context.node),
        emit: printEvent,
        output: (line) => process.stderr.write(`[console] ${line}\n`),
      });
    } catch (error) {
      printEvent({
        event: "console.error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  printEvent({
    event: "competition.ready",
    url: hub.url,
    engine: engineId,
    port,
    host: values.host,
    fullAccess: fullAccessEnabled(),
    bundle: root,
    pid: process.pid,
    ...(bundledConsole ? { consoleUrl: bundledConsole.url } : {}),
  });
  if (bundledConsole) {
    const opened = bundledConsole;
    process.stderr.write(
      `HarnessHub console: ${opened.url} (competition API ${hub.url})\n`,
    );
    void opened.ready.then((ready) => {
      if (ready && values.open) openBrowser(opened.url, printEvent);
    });
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void Promise.allSettled([bundledConsole?.stop(), hub.server.close()]).then(
      (results) => {
        for (const result of results)
          if (result.status === "rejected") {
            console.error(result.reason);
            process.exitCode = 1;
          }
      },
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await competitionBundleMain(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Competition bundle failed",
    );
    process.exitCode = 1;
  }
}
