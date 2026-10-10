import { captureNativeEnvironment, referencedNativeValues, nativeDescriptorValues } from "../infrastructure/session/native-environment.js";
import { chooseControl } from "../contexts/catalog/application/select-control.js";
export { chooseControl } from "../contexts/catalog/application/select-control.js";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { ControlEvent, ControlLaunch, ControlRun, HarnessControl } from "../contracts/control.js";
import { DiscoveryInputError } from "../contexts/catalog/domain/discovery.js";
import { createNativeControl } from "../adapters/control/factory.js";
import { inventory } from "../infrastructure/catalog/inventory-composition.js";
import { NativeInstallationLocks, type NativeUsageLease } from "../infrastructure/management/native-lock.js";

function timeout(value: string | undefined): number {
  if (value === undefined) return 30000;
  if (!/^[0-9]+$/u.test(value)) throw new DiscoveryInputError("timeout must be an integer");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 100 || number > 300000)
    throw new DiscoveryInputError("timeout must be between 100 and 300000 ms");
  return number;
}
function boundedPath(value: string): string {
  if (!isAbsolute(value) || value.length > 4096 || /[\0\r\n]/u.test(value))
    throw new DiscoveryInputError("paths must be bounded and absolute");
  return resolve(value);
}

/** Explicit controlled invocation. It never substitutes another Harness or retries unknown results. */
export async function main(args: readonly string[]): Promise<number> {
  let control: HarnessControl | undefined;
  let nativeUsage: NativeUsageLease | undefined;
  let ownedRoot: string | undefined;
  let interrupted = false;
  let activeRun: ControlRun | undefined;
  let cleaning = false;
  const signalTasks: Promise<unknown>[] = [];
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    const connection = control, run = activeRun;
    const task = connection === undefined ? undefined : (async () => {
      if (cleaning || run === undefined) { await connection.close(); return; }
      await run.requestStop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const ended = await Promise.race([
          run.result.then(() => true),
          new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 1000); }),
        ]);
        if (!ended) await connection.close();
      } finally { if (timer !== undefined) clearTimeout(timer); }
    })();
    if (task) {
      // Retain and await signal work; attach a handler immediately to avoid unhandled rejection.
      task.catch(() => {});
      signalTasks.push(task);
    }
  };
  let json = false;
  let exitCode = 2;
  try {
    const action = args[0];
    if (action !== "probe" && action !== "run") throw new DiscoveryInputError("expected probe or run");
    const { values } = parseArgs({ args: [...args.slice(1)], options: {
      harness: { type: "string" }, control: { type: "string" }, prompt: { type: "string" },
      manifest: { type: "string" }, "search-dir": { type: "string", multiple: true },
      "package-root": { type: "string", multiple: true }, "path-only": { type: "boolean" },
      cwd: { type: "string" }, "config-home": { type: "string" }, "timeout-ms": { type: "string" },
      json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    }, strict: true, allowPositionals: false });
    json = values.json ?? false;
    if (values.help) {
      process.stdout.write("HarnessGateway " + action + " --harness <id> [--control <id>]\nrun另需 --prompt <text>；--json 输出NDJSON事件\n--manifest <file> 指定目录覆盖；--package-root <absolute> 已安装包根\n--cwd <absolute> 工作目录；--config-home <absolute> 已准备的私有配置根\n--timeout-ms <100..300000> 预算（默认30000）\n默认沿用本机已有配置和登录；不安装依赖。probe只初始化，run明确发送一条消息。\n");
      return 0;
    }
    if (!values.harness || !/^[a-z][a-z0-9-]{0,95}$/u.test(values.harness)) throw new DiscoveryInputError("--harness must name a catalog id or alias");
    if (action === "run" && (values.prompt === undefined || !values.prompt.trim() || Buffer.byteLength(values.prompt, "utf8") > 64 * 1024 || values.prompt.includes("\0")))
      throw new DiscoveryInputError("run requires a nonempty prompt of at most 64 KiB");
    if (action === "probe" && values.prompt !== undefined) throw new DiscoveryInputError("probe does not accept a prompt");
    const budget = timeout(values["timeout-ms"]);
    const explicitCwd = values.cwd === undefined ? undefined : boundedPath(values.cwd);
    const explicitHome = values["config-home"] === undefined ? undefined : boundedPath(values["config-home"]);
    for (const path of [explicitCwd, explicitHome]) if (path !== undefined && !(await stat(path)).isDirectory())
      throw new DiscoveryInputError("working/configuration path must be an existing directory");
    const observed = await inventory({
      ...(values.manifest === undefined ? {} : { manifest: values.manifest }),
      searchDirs: values["search-dir"] ?? [], packageRoots: values["package-root"] ?? [], pathOnly: values["path-only"] ?? false,
    });
    const harness = observed.report.harnesses.find((item) => item.id === values.harness || item.aliases.includes(values.harness!));
    if (!harness) throw new DiscoveryInputError("unknown Harness: " + values.harness);
    const selected = chooseControl(harness.controls, values.control);
    if (selected.protocol !== "acp-v1" && selected.protocol !== "codex-app-server" && selected.protocol !== "pi-rpc")
      throw new DiscoveryInputError("this control Driver is not implemented: " + selected.protocol);
    if (selected.command === null) throw new DiscoveryInputError("selected control has no resolved command");
    ownedRoot = await mkdtemp(join(tmpdir(), "harness-control-"));
    const native = captureNativeEnvironment();
    const cwd = explicitCwd ?? join(ownedRoot, "workspace");
    if (explicitCwd === undefined) await mkdir(cwd);
    const environment: Record<string, string> = { ...await referencedNativeValues(native, explicitHome ?? null, harness.id, cwd), ...nativeDescriptorValues(native, explicitHome ?? null, selected.command.env),
      PATH: observed.searchPath, OPENCODE_DISABLE_AUTOUPDATE: "true", PWD: cwd };
    const launch: ControlLaunch = { ...selected.command, env: environment, protocol: selected.protocol };
    const options = { cwd, env: environment, requestTimeoutMs: Math.min(10000, budget), runTimeoutMs: budget, maxFrameBytes: 2 * 1024 * 1024, maxDiagnosticBytes: 64 * 1024, closeGraceMs: 500 };
    nativeUsage = new NativeInstallationLocks().read(harness.id);
    control = await createNativeControl(harness.id, launch, options);
    process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
    const protocol = await control.initialize();
    if (json) process.stdout.write(JSON.stringify({ type: "protocol", harnessId: harness.id, controlId: selected.id, observation: protocol }) + "\n");
    else process.stdout.write(harness.name + " · " + protocol.protocol + " · 协议已响应（不代表认证或任务通过）\n");
    if (interrupted) throw new Error("invocation interrupted during initialization");
    if (action === "probe") exitCode = 0;
    else {
      const nativeId = await control.open(cwd);
      const onEvent = (event: ControlEvent) => {
        if (json) process.stdout.write(JSON.stringify({ type: "event", event }) + "\n");
        else if (event.type === "text") process.stdout.write(event.text);
        else process.stderr.write("[" + event.type + "] " + (event.type === "diagnostic" ? event.message : event.type === "tool" ? event.title : event.decision) + "\n");
      };
      activeRun = await control.startText(nativeId, values.prompt!, onEvent);
      if (interrupted) await activeRun.requestStop();
      const result = await activeRun.result;
      if (json) process.stdout.write(JSON.stringify({ type: "result", result }) + "\n");
      else process.stdout.write("\n后端结果：" + result.status + " (" + result.reason + ")\n");
      exitCode = result.status === "completed" && !interrupted ? 0 : 1;
    }
  } catch (error: unknown) {
    process.stderr.write("HarnessGateway: " + (error instanceof Error ? error.message : "control failed") + "\n");
    exitCode = 2;
  } finally {
    cleaning = true;
    for (const result of await Promise.allSettled(signalTasks)) if (result.status === "rejected") {
      process.stderr.write("HarnessGateway: stop request failed\n"); exitCode = 1;
    }
    let resourcesClosed = control === undefined;
    if (control) {
      try {
        const cleanup = await control.close();
        resourcesClosed = true;
        if (json) process.stdout.write(JSON.stringify({ type: "cleanup", cleanup }) + "\n");
        if (cleanup.protocolFailure !== null) {
          process.stderr.write("HarnessGateway: connection failed: " + cleanup.protocolFailure.code + " — " + cleanup.protocolFailure.message + "\n");
          exitCode = 1;
        }
      } catch (error: unknown) {
        process.stderr.write("HarnessGateway: cleanup failed: " + (error instanceof Error ? error.message : "unknown") + "\n"); exitCode = 1;
      }
    }
    nativeUsage?.release(resourcesClosed);
    if (ownedRoot && resourcesClosed) {
      try { await rm(ownedRoot, { recursive: true, force: true }); }
      catch { process.stderr.write("HarnessGateway: private temporary directory cleanup failed\n"); exitCode = 1; }
    } else if (ownedRoot) {
      process.stderr.write("HarnessGateway: private directory retained because process cleanup is unconfirmed: " + ownedRoot + "\n");
    }
    for (const result of await Promise.allSettled(signalTasks)) if (result.status === "rejected") exitCode = 1;
    process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
    if (interrupted && exitCode === 0) exitCode = 1;
  }
  return exitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
