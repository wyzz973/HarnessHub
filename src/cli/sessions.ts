import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sessionId, SessionError } from "../contracts/session.js";
import { SqliteSessionReader } from "../infrastructure/session/session-reader.js";
import { checkUpgrade, describeCheck } from "../infrastructure/session/upgrade-preflight.js";
import { application, dataRoot, errorRecord, newCommand, selection } from "./session-application.js";
import { boundedWrite } from "./bounded-streams.js";

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const number = value === undefined ? fallback : /^[0-9]+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new SessionError("INVALID_INPUT", "invalid cursor or page limit"); return number;
}
export async function main(args: readonly string[]): Promise<number> {
  let reader: SqliteSessionReader | undefined;
  let app: ReturnType<typeof application> | undefined;
  let code = 0;
  try {
    const action = args[0];
    if (!["list", "show", "events", "close", "resume", "check-upgrade"].includes(action ?? "")) throw new SessionError("INVALID_INPUT", "expected list/show/events/close/resume/check-upgrade");
    const { values } = parseArgs({ args: [...args.slice(1)], options: {
      "data-dir": { type: "string" }, session: { type: "string" }, json: { type: "boolean" },
      "after-seq": { type: "string" }, limit: { type: "string" }, "command-id": { type: "string" }, help: { type: "boolean", short: "h" },
      harness: { type: "string" }, "acknowledge-unknown": { type: "boolean" }, "workspace-lock-root": { type: "string" },
    }, strict: true, allowPositionals: false });
    if (values.help) { process.stdout.write("HarnessGateway sessions list/show/events/close/resume --data-dir <path> [--session <id>] [--json] [--workspace-lock-root <绝对目录>]\n读操作不取得writer owner；close保留历史。resume检查关闭证据并验证目标；可用--harness指定目标，结果未知时另需--acknowledge-unknown，不重跑旧任务。\nHarnessGateway sessions check-upgrade --data-dir <path> [--json]\n只读预检：在内存里把这个数据目录的升级整个走一遍（两个阶段、逐个对话），说出哪些对话会让升级停下以及原因；不写任何文件、不取得所有权，服务运行时也能跑；输出只有数目、对话 id 和规则名，不含对话内容。全部通过退出码 0，有对话不通过退出码 1，没能检查退出码 2。\n"); return 0; }
    if (action !== "list" && action !== "check-upgrade" && values.session === undefined) throw new SessionError("INVALID_INPUT", "--session is required");
    if (action !== "events" && values["after-seq"] !== undefined) throw new SessionError("INVALID_INPUT", "--after-seq is only used with events");
    if (action !== "resume" && (values.harness !== undefined || values["acknowledge-unknown"] !== undefined)) throw new SessionError("INVALID_INPUT", "recovery options are only used with resume");
    const root = dataRoot(values["data-dir"]), limit = integer(values.limit, 50, 1, 100);
    let output: unknown;
    if (action === "check-upgrade") {
      // Read-only and ownerless: neither the application nor a reader is opened; the check reads the library on its own.
      if (values.session !== undefined || values["after-seq"] !== undefined) throw new SessionError("INVALID_INPUT", "check-upgrade takes only --data-dir and --json");
      const check = checkUpgrade(root, process.stderr.isTTY ? { progress: (done, total) => { process.stderr.write("\r" + done + " of " + total + " conversations checked" + (done === total ? "\n" : "")); } } : {});
      boundedWrite(process.stdout, values.json ? JSON.stringify(check) + "\n" : describeCheck(check).join("\n") + "\n");
      return check.ok ? 0 : 1;
    }
    if (action === "resume") {
      app = application(root, () => {}, values["workspace-lock-root"] === undefined ? {} : { workspaceLockRoot: values["workspace-lock-root"] });
      const id = sessionId(values.session), current = app.runtime.read(id);
      output = app.runtime.resume(id, values.harness === undefined ? current.selection : selection(values.harness), values["command-id"] ?? newCommand("resume"), values["acknowledge-unknown"] ?? false);
      await app.runtime.wait(id);
    } else if (action === "close") {
      app = application(root, () => {}, values["workspace-lock-root"] === undefined ? {} : { workspaceLockRoot: values["workspace-lock-root"] });
      output = await app.runtime.closeSession(sessionId(values.session), values["command-id"] ?? newCommand("close"));
    } else {
      reader = new SqliteSessionReader(root);
      // A database whose upgrade to the tables has not finished holds conversations of both kinds: each is read as it is, and the tool says the rest are not converted yet.
      const upgrade = reader.upgrade();
      if (upgrade.kind === "converting") process.stderr.write("HarnessGateway: UPGRADE_UNDER_WAY — " + upgrade.message + "\n");
      output = action === "list" ? reader.list(limit)
        : action === "show" ? reader.get(sessionId(values.session))
        : reader.events(sessionId(values.session), integer(values["after-seq"], 0, 0, Number.MAX_SAFE_INTEGER), limit);
    }
    boundedWrite(process.stdout, JSON.stringify(output, null, values.json ? undefined : 2) + "\n");
  } catch (error) { const fault = errorRecord(error); process.stderr.write("HarnessGateway: " + fault.code + " — " + fault.message + "\n"); code = args[0] === "check-upgrade" ? 2 : 1; }
  finally {
    try { reader?.close(); }
    catch (error) { const fault = errorRecord(error); process.stderr.write("HarnessGateway: " + fault.code + " — " + fault.message + "\n"); code = 1; }
    if (app) {
      try { await app.runtime.close(); }
      catch (error) { const fault = errorRecord(error); process.stderr.write("HarnessGateway: " + fault.code + " — " + fault.message + "\n"); code = 1; }
      try { await app.management.shutdown(); }
      catch (error) { const fault = errorRecord(error); process.stderr.write("HarnessGateway: " + fault.code + " — " + fault.message + "\n"); code = 1; }
      try { await app.providers.shutdown(); }
      catch (error) { const fault = errorRecord(error); process.stderr.write("HarnessGateway: " + fault.code + " — " + fault.message + "\n"); code = 1; }
      try { app.store.close(); }
      catch (error) { const fault = errorRecord(error); process.stderr.write("HarnessGateway: " + fault.code + " — " + fault.message + "\n"); code = 1; }
    }
  }
  return code;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
