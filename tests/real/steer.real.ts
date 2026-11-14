import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application as composeApplication } from "../../src/cli/session-application.js";
import { PERMISSION_KEY } from "../../src/contracts/flavor.js";
import type { ProtocolItem } from "../../src/contracts/protocol.js";
import { TABLE_COMMAND_DIR } from "../../src/contracts/table.js";
import type { HarnessView, ItemView, RunItemsPageView, SessionViewV14 } from "../../src/contracts/web.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { MemoryTableGrants } from "../../src/infrastructure/session/table-grants.js";
import { TableMount } from "../../src/infrastructure/table/mount.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";
import { describeGuard, guardTargets, recheck, snapshot } from "./guard.js";

/**
 * Words given to a Turn in progress, on the user's installed Harnesses through the Gateway's HTTP API (the page's path), on a Gateway of its own (a free
 * port, its data and its workspace in temporary directories, removed afterwards). Each Harness is asked to do something that takes several steps and to
 * answer A; once its first command runs it is told, mid-turn, to answer B instead (`POST /sessions/:id/steer`). Judged on the Turn's own items: the words
 * stand in it as a steered user message, the Turn completed and its answer is B. A steer after the Turn ended must be refused (STEER_NO_ACTIVE_TURN).
 *
 * Outside the sandbox, from the repository root after `pnpm build`:
 *   . "$HOME/.cache/harnesshub-acceptance/env.sh"
 *   RUN HH_REAL_MODEL_CLAUDE=haiku HH_STEER_HARNESSES=claude,codex node --test dist/tests/real/steer.real.js
 * HH_STEER_REFUSED=opencode: Harnesses whose running Turn must refuse the words (STEER_UNSUPPORTED) instead. HH_STEER_HARNESSES=none runs none of the first kind.
 */
/** A list of Harnesses from the environment; `none` is none. */
const list = (name: string, fallback: string) => (process.env[name]?.trim() || fallback).split(",").map(value => value.trim()).filter(value => value !== "" && value !== "none");
const TAKING = list("HH_STEER_HARNESSES", "claude,codex"), REFUSING = list("HH_STEER_REFUSED", "");
const environment = captureNativeEnvironment();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const TASK = "请按顺序做这几步：先用 shell 运行命令 `sleep 5`，等它结束后再运行一次 `sleep 5`，两次都运行完以后，只回复一个大写字母 A，不要说别的。";
const STEER = "改主意了：最后不要回复 A，改成只回复一个大写字母 B，不要说别的。两次 sleep 照常做完。";

interface Api { post(path: string, input: unknown): Promise<{ readonly status: number; readonly body: Record<string, unknown> }>; get(path: string): Promise<unknown> }
async function login(server: WebServer): Promise<Api> {
  const start = new URL(server.url), origin = start.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(start.hash.slice(1)).get("token") }) });
  assert.equal(boot.status, 200);
  const cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!, csrf = String((await boot.json() as { csrfToken: string }).csrfToken);
  return {
    post: async (path, input) => {
      const response = await fetch(origin + "/api/v1" + path, { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(input) });
      return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
    },
    get: async path => {
      const response = await fetch(origin + "/api/v1" + path, { headers: { Cookie: cookie, Origin: origin } });
      const text = await response.text();
      if (!response.ok) throw new Error("GET " + path.replace(/session-[\w-]+/gu, ":id") + " " + response.status + " " + text.slice(0, 200));
      return JSON.parse(text) as unknown;
    },
  };
}
async function items(api: Api, id: string, ordinal: number): Promise<ProtocolItem[]> {
  const found: ProtocolItem[] = [];
  for (let after = 0; ;) {
    const page = await api.get("/sessions/" + id + "/runs/" + ordinal + "/items?after=" + after + "&limit=200") as RunItemsPageView;
    for (const item of page.items) found.push(item.bodyOmitted === true || item.textBytes !== undefined ? (await api.get("/sessions/" + id + "/runs/" + ordinal + "/items/" + item.seq) as ItemView).item : item);
    if (page.next === null) return found;
    after = page.next;
  }
}
const head = async (api: Api, id: string) => (await api.get("/sessions/" + id) as SessionViewV14).head;
async function settled(api: Api, id: string, minutes = 6): Promise<void> {
  for (const deadline = Date.now() + minutes * 60_000; ;) {
    const now = await head(api, id);
    if (now.runCount >= 1 && now.facts.settled) return;
    if (Date.now() > deadline) throw new Error("the Turn did not end within " + minutes + " minutes");
    await sleep(500);
  }
}
/** Waits until the Turn's first command runs (it works on its steps), and says what it saw by then. */
async function working(api: Api, id: string): Promise<string> {
  for (const deadline = Date.now() + 4 * 60_000; ;) {
    const now = await items(api, id, 0).catch(() => []);
    const command = now.find(item => item.type === "command" || item.type === "tool");
    if (command !== undefined) return command.type + " " + command.status;
    if ((await head(api, id)).facts.settled) throw new Error("the Turn ended before it ran a command");
    if (Date.now() > deadline) throw new Error("no command ran within 4 minutes");
    await sleep(300);
  }
}

test("words given to a Turn in progress on the installed Harnesses", { timeout: 60 * 60 * 1000 }, async () => {
  const harnesses = [...new Set([...TAKING, ...REFUSING])];
  guardTargets(harnesses);
  const before = await snapshot(harnesses, environment);
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-steer-"))), hidden = await realpath(await mkdtemp(join(tmpdir(), "hh-steer-data-")));
  const results: Record<string, unknown>[] = [];
  let server: WebServer | undefined;
  try {
    const data = join(hidden, "data"), locks = join(hidden, "locks"), workspace = join(root, "ws");
    await mkdir(locks, { recursive: true, mode: 0o700 }); await mkdir(workspace, { recursive: true });
    const table = new TableMount(new MemoryTableGrants(), join(data, TABLE_COMMAND_DIR));
    const configuration = await prepareConfiguration({ workspace });
    server = await startWebServer({ root: data, configuration, port: 0, installations: "official", workspaceLockRoot: locks, table, loginShell: false,
      application: (dataRoot, publish) => composeApplication(dataRoot, publish, { installations: "official", workspaceLockRoot: locks, table, tableGrants: table.grants }) });
    const api = await login(server), views = await api.get("/harnesses") as HarnessView[];
    for (const harnessId of harnesses) {
      const result: Record<string, unknown> = { harnessId, expect: TAKING.includes(harnessId) ? "taken" : "refused" };
      results.push(result);
      if (!views.some(view => view.id === harnessId && view.controls.some(control => control.available))) { result.verdict = "跳过：不可用"; continue; }
      const model = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()];
      const created = await api.post("/sessions", { workspace, selection: { harnessId, ...(model === undefined ? {} : { nativeModel: model }), nativeOptions: { [PERMISSION_KEY]: "auto" } }, commandId: "create-" + randomUUID() });
      assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 300));
      const id = String((created.body as unknown as SessionViewV14).head.id), started = Date.now();
      const sent = await api.post("/sessions/" + id + "/messages", { text: TASK, commandId: "send-" + randomUUID() });
      assert.equal(sent.status, 202);
      result.workingAt = await working(api, id);
      await sleep(1000);
      const key = "steer-" + randomUUID(), answer = await api.post("/sessions/" + id + "/steer", { text: STEER, key });
      result.steer = { status: answer.status, ...(answer.status === 200 ? { outcome: answer.body.outcome } : { code: answer.body.code }), afterMs: Date.now() - started };
      // The same key again: the same answer, nothing given twice.
      const repeat = await api.post("/sessions/" + id + "/steer", { text: STEER, key });
      result.repeat = { status: repeat.status, ...(repeat.status === 200 ? { replayed: repeat.body.replayed, sameMessage: repeat.body.messageId === answer.body.messageId } : { code: repeat.body.code }) };
      await settled(api, id);
      const turn = await items(api, id, 0), view = (await api.get("/sessions/" + id) as SessionViewV14).window.turns.find(row => row.run.ordinal === 0)!;
      const steered = turn.filter(item => item.type === "user_message" && item.steered === true);
      const reply = turn.flatMap(item => item.type === "assistant_message" ? [item.text ?? ""] : []).join("\n").trim();
      const last = turn.filter(item => item.type === "assistant_message").at(-1);
      result.turn = { status: view.run.status, ms: Date.now() - started, items: turn.map(item => item.type + (item.type === "user_message" && item.steered ? "(steered " + item.status + ")" : item.type === "command" ? "(" + item.command.slice(0, 40) + " " + item.status + ")" : "")).join(" → "),
        steered: steered.map(item => ({ status: item.status, text: item.type === "user_message" ? item.text : undefined })), lastReply: (last?.type === "assistant_message" ? last.text ?? "" : "").trim().slice(0, 200), reply: reply.slice(-300) };
      const late = await api.post("/sessions/" + id + "/steer", { text: "太晚了", key: "late-" + randomUUID() });
      result.late = { status: late.status, code: late.body.code };
      const finalAnswer = (last?.type === "assistant_message" ? last.text ?? "" : "").trim();
      if (TAKING.includes(harnessId)) {
        const ok = answer.status === 200 && answer.body.outcome === "taken" && steered.length === 1 && steered[0]!.status === "completed" && steered[0]!.type === "user_message" && steered[0]!.text === STEER
          && view.run.status === "completed" && /B/u.test(finalAnswer) && !/A/u.test(finalAnswer) && late.status === 409 && late.body.code === "STEER_NO_ACTIVE_TURN";
        result.verdict = ok ? "过" : "不过";
      } else {
        result.verdict = answer.status === 409 && answer.body.code === "STEER_UNSUPPORTED" && steered.length === 0 ? "过（拒绝）" : "不过";
      }
      console.log(JSON.stringify(result, null, 1));
    }
  } finally {
    try { await server?.close(); } finally {
      const guard = await recheck(before, environment);
      console.log("guard: " + (guard.unchanged ? "unchanged" : describeGuard(guard)));
      if (process.env.HH_REAL_KEEP !== "1") { await rm(root, { recursive: true, force: true }); await rm(hidden, { recursive: true, force: true }); }
      assert.ok(guard.unchanged, describeGuard(guard));
    }
  }
  assert.deepEqual(results.filter(row => typeof row.verdict === "string" && (row.verdict as string).startsWith("不过")).map(row => row.harnessId), []);
});
