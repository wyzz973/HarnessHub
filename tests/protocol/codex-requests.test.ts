import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ControlEvent, ControlOptions } from "../../src/contracts/control.js";
import { CodexControl } from "../../src/adapters/control/codex.js";
import { codexFlavor } from "../../src/adapters/flavors/codex.js";

/**
 * A minimal Codex app-server (0.169.0 shapes) whose turn asks every kind of server request at once: a sandbox escalation, a simple MCP form, an
 * MCP link (url mode), a dynamic tool call, and a command approval it resolves itself (`serverRequest/resolved`) before anyone answers. It completes
 * the turn once the four it waits for are answered. Every line it receives goes to the trace.
 */
const PEER = `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const trace = process.env.PEER_TRACE, send = message => process.stdout.write(JSON.stringify(message) + "\\n"), notify = (method, params) => send({ method, params });
const waiting = new Set(["perm-1", "elicit-1", "url-1", "tool-1"]);
let thread = "thread-requests", turn = null;
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  appendFileSync(trace, line + "\\n");
  if (message.method === "initialize") { send({ id: message.id, result: { userAgent: "peer-codex/0.169.0 (fixture)" } }); return; }
  if (message.method === "initialized") return;
  if (message.method === "config/read") { send({ id: message.id, result: { config: { model: "peer-model", model_reasoning_summary: "concise", ...(process.env.PEER_PROJECTS ? { projects: JSON.parse(process.env.PEER_PROJECTS) } : {}) } } }); return; }
  if (message.method === "model/list") { send({ id: message.id, result: { data: [{ model: "peer-model", displayName: "Peer" }], nextCursor: null } }); return; }
  if (message.method === "thread/start") { notify("thread/started", { thread: { id: thread } }); send({ id: message.id, result: { thread: { id: thread }, model: "peer-model", approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" } } }); return; }
  if (message.method === "turn/start") {
    turn = "turn-1"; const base = { threadId: thread, turnId: turn };
    send({ id: message.id, result: { turn: { id: turn, status: "inProgress" } } });
    notify("turn/started", { threadId: thread, turn: { id: turn, status: "inProgress" } });
    send({ id: "approval-5", method: "item/commandExecution/requestApproval", params: { ...base, itemId: "cmd-5", command: "curl https://example.invalid", cwd: "/w", startedAtMs: 1,
      networkApprovalContext: { host: "example.invalid", protocol: "https" },
      availableDecisions: ["accept", { applyNetworkPolicyAmendment: { network_policy_amendment: { action: "deny", host: "example.invalid" } } }, "acceptForSession",
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["curl"] } }, { applyNetworkPolicyAmendment: { network_policy_amendment: { action: "allow", host: "example.invalid" } } }, "decline", "cancel"] } });
    setTimeout(() => notify("serverRequest/resolved", { threadId: thread, requestId: "approval-5" }), 80);
    setTimeout(() => {
      send({ id: "perm-1", method: "item/permissions/requestApproval", params: { ...base, itemId: "perm-item", cwd: "/w", reason: "needs the network and a folder", startedAtMs: 1, permissions: { network: { enabled: true }, fileSystem: { write: ["/w/out"] } } } });
      send({ id: "elicit-1", method: "mcpServer/elicitation/request", params: { ...base, serverName: "docs", mode: "form", message: "Name the report", requestedSchema: { type: "object", properties: { name: { type: "string", title: "Name" }, size: { type: "integer", title: "Pages" } }, required: ["name"] } } });
      send({ id: "url-1", method: "mcpServer/elicitation/request", params: { ...base, serverName: "auth", mode: "url", message: "Sign in", url: "https://example.invalid/login", elicitationId: "e-1" } });
      send({ id: "tool-1", method: "item/tool/call", params: { ...base, callId: "c-1", tool: "anything", arguments: {} } });
    }, 160);
    return;
  }
  if (message.method === undefined && waiting.delete(message.id) && waiting.size === 0) {
    notify("item/completed", { threadId: thread, turnId: turn, item: { type: "agentMessage", id: "msg-1", text: "done", phase: "final_answer" } });
    notify("turn/completed", { threadId: thread, turn: { id: turn, status: "completed" } });
  }
  if (message.method !== undefined && message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
});
`;
const options: ControlOptions = { cwd: process.cwd(), env: {}, requestTimeoutMs: 2000, runTimeoutMs: 8000, maxFrameBytes: 1 << 20, maxDiagnosticBytes: 1 << 14, closeGraceMs: 150 };

test("Codex answers every server request: a part of an escalation, a simple MCP form as questions, a link declined with a notice, a dynamic tool declined, and a request Codex resolved itself closed without an answer", async t => {
  const root = await mkdtemp(join(tmpdir(), "codex-requests-")); t.after(() => rm(root, { recursive: true, force: true }));
  const peer = join(root, "peer.mjs"), trace = join(root, "trace.ndjson"); await writeFile(peer, PEER);
  const driver = new CodexControl({ protocol: "codex-app-server", executable: process.execPath, args: [peer], env: { PEER_TRACE: trace } }, options);
  t.after(() => driver.close().then(() => undefined, () => undefined));
  await driver.initialize(); driver.enablePermissions();
  const id = await driver.open(process.cwd()), events: ControlEvent[] = [], decisions: Promise<void>[] = [];
  const run = await driver.startText(id, "go", event => {
    events.push(event);
    if (event.type !== "permission_requested" || event.id === "approval-5") return;
    if (event.id === "perm-1") decisions.push(driver.decidePermission(event.id, "network"));
    else if (event.id === "elicit-1:0") decisions.push(driver.decidePermission(event.id, "submit", "Ada"));
    else if (event.id === "elicit-1:1") decisions.push(driver.decidePermission(event.id, "submit", "abc").then(() => assert.fail("not a number"), () => driver.decidePermission(event.id, "submit", "3")));
  });
  assert.equal((await run.result).status, "completed"); await Promise.all(decisions);
  await driver.close();
  const answers = new Map((await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { id?: string; result?: unknown; method?: string }).filter(row => row.method === undefined).map(row => [row.id, row.result]));
  assert.deepEqual(answers.get("perm-1"), { permissions: { network: { enabled: true } }, scope: "turn" }, "only the network, for this turn");
  assert.deepEqual(answers.get("elicit-1"), { action: "accept", content: { name: "Ada", size: 3 } });
  assert.deepEqual(answers.get("url-1"), { action: "decline" });
  assert.equal((answers.get("tool-1") as { success?: boolean }).success, false);
  assert.equal(answers.has("approval-5"), false, "a request Codex resolved itself is not answered");
  assert.ok(events.some(event => event.type === "permission" && event.id === "approval-5" && event.decision === "cancelled"));
  const command = events.find(event => event.type === "permission_requested" && event.id === "approval-5");
  assert.ok(command?.type === "permission_requested");
  assert.equal(command.toolKind, "fetch"); assert.equal(command.title, "Codex 请求联网：example.invalid");
  assert.deepEqual(command.options.map(option => option.id), ["accept", "acceptForSession", "acceptWithExecpolicyAmendment", "applyNetworkPolicyAmendment:4", "decline", "cancel", "applyNetworkPolicyAmendment:1"],
    "allowing first, then remembering, then refusing; a remembered refusal last");
  const escalation = events.find(event => event.type === "permission_requested" && event.id === "perm-1");
  assert.ok(escalation?.type === "permission_requested"); assert.equal(escalation.toolKind, "other", "the network and a write at once are neither alone");
  assert.ok(events.some(event => event.type === "permission_requested" && event.id === "elicit-1:0" && event.kind === "question" && event.input?.kind === "text"));
  assert.ok(events.some(event => event.type === "notice" && event.title.includes("auth")), "the declined link is said");
  assert.deepEqual(events.filter(event => event.type === "text").map(event => event.type === "text" ? [event.text, event.item] : null), [["done", "msg-1"]]);
  const sent = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
  const turn = sent.find(row => row.method === "turn/start")!.params!;
  assert.equal(turn.summary, "concise", "the user's own reasoning summary"); assert.equal(turn.model, "peer-model"); assert.equal(turn.approvalPolicy, "on-request");
  assert.deepEqual(turn.collaborationMode, { mode: "default", settings: { model: "peer-model", reasoning_effort: null, developer_instructions: null } }, "both modes, every turn");
});

test("Codex opens an auto thread on-request with Codex's own auto-review, and gives the thread a trust decision of its own only where the user made none", async t => {
  const root = await mkdtemp(join(tmpdir(), "codex-auto-")); t.after(() => rm(root, { recursive: true, force: true }));
  const peer = join(root, "peer.mjs"); await writeFile(peer, PEER);
  const opened = async (name: string, env: Record<string, string>) => {
    const trace = join(root, name + ".ndjson");
    const driver = new CodexControl({ protocol: "codex-app-server", executable: process.execPath, args: [peer], env: { PEER_TRACE: trace, ...env } }, { ...options, flavor: codexFlavor, permission: "auto" });
    try { await driver.initialize(); await driver.open(process.cwd()); } finally { await driver.close(); }
    return (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { method?: string; params?: Record<string, unknown> }).find(row => row.method === "thread/start")!.params!;
  };
  const fresh = await opened("fresh", {});
  assert.equal(fresh.approvalPolicy, "on-request"); assert.equal(fresh.sandbox, "workspace-write"); assert.equal(fresh.approvalsReviewer, "auto_review");
  assert.deepEqual((fresh.config as { projects?: Record<string, unknown> }).projects?.[process.cwd()], { trust_level: "trusted" }, "what Codex would write into config.toml, for this thread alone");
  const decided = await opened("decided", { PEER_PROJECTS: JSON.stringify({ [process.cwd()]: { trust_level: "untrusted" } }) });
  assert.equal((decided.config as { projects?: unknown } | undefined)?.projects, undefined, "the user's own decision stands");
});
