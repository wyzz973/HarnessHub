import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sessionId, SessionError } from "../contracts/session.js";
import { FileSessionReader } from "../infrastructure/session/file-reader.js";
import { application, dataRoot, errorRecord, newCommand, selection } from "./session-application.js";
import { boundedWrite } from "./bounded-streams.js";

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const number = value === undefined ? fallback : /^[0-9]+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new SessionError("INVALID_INPUT", "invalid cursor or page limit"); return number;
}
export async function main(args: readonly string[]): Promise<number> {
  let reader: FileSessionReader | undefined;
  let app: ReturnType<typeof application> | undefined;
  let code = 0;
  try {
    const action = args[0];
    if (!["list", "show", "events", "close", "resume"].includes(action ?? "")) throw new SessionError("INVALID_INPUT", "expected list/show/events/close/resume");
    const { values } = parseArgs({ args: [...args.slice(1)], options: {
      "data-dir": { type: "string" }, session: { type: "string" }, json: { type: "boolean" },
      "after-seq": { type: "string" }, limit: { type: "string" }, "command-id": { type: "string" }, help: { type: "boolean", short: "h" },
      harness: { type: "string" }, "acknowledge-unknown": { type: "boolean" }, "workspace-lock-root": { type: "string" },
    }, strict: true, allowPositionals: false });
    if (values.help) { process.stdout.write("HarnessGateway sessions list/show/events/close/resume --data-dir <path> [--session <id>] [--json] [--workspace-lock-root <绝对目录>]\n读操作不取得writer owner；close保留历史。resume检查关闭证据并验证目标；可用--harness指定目标，结果未知时另需--acknowledge-unknown，不重跑旧任务。\n对话存在数据目录的 sessions/ 下，一个对话一个 .jsonl 文件。\n"); return 0; }
    if (action !== "list" && values.session === undefined) throw new SessionError("INVALID_INPUT", "--session is required");
    if (action !== "events" && values["after-seq"] !== undefined) throw new SessionError("INVALID_INPUT", "--after-seq is only used with events");
    if (action !== "resume" && (values.harness !== undefined || values["acknowledge-unknown"] !== undefined)) throw new SessionError("INVALID_INPUT", "recovery options are only used with resume");
    const root = dataRoot(values["data-dir"]), limit = integer(values.limit, 50, 1, 100);
    let output: unknown;
    if (action === "resume") {
      app = application(root, () => {}, { ...(values["workspace-lock-root"] === undefined ? {} : { workspaceLockRoot: values["workspace-lock-root"] }) });
      // What it needs of the conversation is the Harness it selects now: the head says (the Turns are not read).
      const id = sessionId(values.session), selected = app.store.head(id).head.selection;
      output = app.runtime.resume(id, values.harness === undefined ? selected : selection(values.harness), values["command-id"] ?? newCommand("resume"), values["acknowledge-unknown"] ?? false);
      await app.runtime.wait(id);
    } else if (action === "close") {
      app = application(root, () => {}, { ...(values["workspace-lock-root"] === undefined ? {} : { workspaceLockRoot: values["workspace-lock-root"] }) });
      const closed = await app.runtime.closeSession(sessionId(values.session), values["command-id"] ?? newCommand("close"));
      // What closing did: the conversation's head after it (its history is read with `show`).
      output = { id: closed.id, status: closed.status, epoch: closed.epoch, version: closed.version, lastSeq: closed.lastSeq, selection: closed.selection, runs: closed.runs.length };
    } else {
      reader = new FileSessionReader(root);
      output = action === "list" ? reader.list(limit)
        : action === "show" ? reader.get(sessionId(values.session))
        : reader.events(sessionId(values.session), integer(values["after-seq"], 0, 0, Number.MAX_SAFE_INTEGER), limit);
    }
    boundedWrite(process.stdout, JSON.stringify(output, null, values.json ? undefined : 2) + "\n");
  } catch (error) { const fault = errorRecord(error); process.stderr.write("HarnessGateway: " + fault.code + " — " + fault.message + "\n"); code = 1; }
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
/** Whether this module is the program Node was started with, by real paths: an entry reached through a link (macOS's `/var` → `/private/var`, a linked checkout) runs too. */
function started(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  if (import.meta.url === pathToFileURL(resolve(entry)).href) return true;
  try { const self = realpathSync(fileURLToPath(import.meta.url)); return [resolve(entry), resolve(entry) + ".js"].some(candidate => { try { return realpathSync(candidate) === self; } catch { return false; } }); }
  catch { return false; }
}
if (started()) process.exitCode = await main(process.argv.slice(2));
