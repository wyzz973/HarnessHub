import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sessionId, SessionError } from "../contracts/session.js";
import { SqliteSessionReader } from "../infrastructure/session/sqlite-store.js";
import { application, dataRoot, errorRecord, newCommand } from "./session-application.js";
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
    if (!["list", "show", "events", "close"].includes(action ?? "")) throw new SessionError("INVALID_INPUT", "expected list/show/events/close");
    const { values } = parseArgs({ args: [...args.slice(1)], options: {
      "data-dir": { type: "string" }, session: { type: "string" }, json: { type: "boolean" },
      "after-seq": { type: "string" }, limit: { type: "string" }, "command-id": { type: "string" }, help: { type: "boolean", short: "h" },
    }, strict: true, allowPositionals: false });
    if (values.help) { process.stdout.write("HarnessGateway sessions list/show/events/close --data-dir <path> [--session <id>] [--json]\n读操作不取得writer owner；close持久停止公共Session准入，保留历史。\n"); return 0; }
    if (action !== "list" && values.session === undefined) throw new SessionError("INVALID_INPUT", "--session is required");
    if (action !== "events" && values["after-seq"] !== undefined) throw new SessionError("INVALID_INPUT", "--after-seq is only used with events");
    const root = dataRoot(values["data-dir"]), limit = integer(values.limit, 50, 1, 100);
    let output: unknown;
    if (action === "close") {
      app = application(root, () => {});
      output = await app.runtime.closeSession(sessionId(values.session), values["command-id"] ?? newCommand("close"));
    } else {
      reader = new SqliteSessionReader(root);
      output = action === "list" ? reader.list(limit).map(item => ({ id: item.id, status: item.status, epoch: item.epoch, selection: item.selection, runs: item.runs.length, lastSeq: item.lastSeq }))
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
      try { await app.providers.shutdown(); }
      catch (error) { const fault = errorRecord(error); process.stderr.write("HarnessGateway: " + fault.code + " — " + fault.message + "\n"); code = 1; }
      try { app.store.close(); }
      catch (error) { const fault = errorRecord(error); process.stderr.write("HarnessGateway: " + fault.code + " — " + fault.message + "\n"); code = 1; }
    }
  }
  return code;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
