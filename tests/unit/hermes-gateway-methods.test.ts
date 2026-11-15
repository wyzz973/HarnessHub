import assert from "node:assert/strict";
import test from "node:test";
import { ALLOWED_METHODS, MUTATIONS, assertAllowed } from "../../src/adapters/control/hermes/methods.js";

// The Hermes gateway also runs the user's messaging bots: the driver may send only the methods on its list (2026-11-15). This locks the
// list, and a change to it is a change of this test.

test("the Hermes driver's method list is exactly these, and nothing that sends, delivers, forwards or schedules is on it", () => {
  assert.deepEqual(Object.keys(ALLOWED_METHODS).sort(), ["approval.respond", "clarify.respond", "commands.catalog", "config.set", "image.attach_bytes", "model.options", "ping",
    "prompt.cancel", "prompt.receipt", "prompt.submit", "rollback.diff", "rollback.list", "rollback.restore", "runtime.describe", "session.create", "session.detach",
    "session.events.since", "session.export", "session.info", "session.interrupt", "session.list", "session.mutate", "session.resume", "session.stats", "session.steer",
    "session.transcript", "slash.exec"]);
  for (const method of ["bot_relay.deliver", "bot_relay.reply", "bot_relay.settle", "bot_relay.outbox.drain", "a2a.forward", "groups.send", "groups.create", "cron.submit", "cron.manage", "kanban.run",
    "shell.exec", "message.react", "prompt.background", "prompt.btw", "connectors.connect", "cli.exec", "command.dispatch", "session.delete", "session.prune", "prompt.resolve_unknown", "llm.oneshot"])
    assert.throws(() => assertAllowed(method, {}), (error: { code?: string }) => error.code === "METHOD_NOT_ALLOWED", method);
});

test("a listed method is still refused with parameters outside its own use: a messaging session, a config write, a deletion, a writing command", () => {
  assert.deepEqual([...MUTATIONS].sort(), ["branch", "compress", "edit_policy", "editor_mcp", "model", "reasoning", "rename", "rewind", "workspace"]);
  const refused = (method: string, params: Record<string, unknown>) => assert.throws(() => assertAllowed(method, params), (error: { code?: string }) => error.code === "METHOD_NOT_ALLOWED", method + " " + JSON.stringify(params));
  refused("session.create", { source: "cli", cwd: "/w" });
  refused("session.create", { source: "acp", api_key: "x" });
  refused("session.create", { source: "acp", client_env: {} });
  for (const operation of ["delete", "reset", "import", "archive", "sidebar"]) refused("session.mutate", { session_id: "s", operation, payload: {} });
  refused("config.set", { key: "model", value: "x" });
  refused("config.set", { key: "show_reasoning", value: "1" });
  refused("prompt.submit", { session_id: "s", text: "x", surface: "telegram" });
  for (const command of ["/cron add", "/kanban create x", "/personality pirate", "/yolo", "/skills approve x", "/usage reset", "/send x"]) refused("slash.exec", { session_id: "s", command });
  assertAllowed("session.create", { source: "acp", cwd: "/w", editor: { mcp_servers: [], edit_approval_policy: "ask" }, checkpoints: true });
  assertAllowed("session.mutate", { session_id: "s", operation: "rewind", payload: { target_message_id: 1 } });
  assertAllowed("config.set", { session_id: "s", key: "show_reasoning", value: "1" });
  assertAllowed("slash.exec", { session_id: "s", command: "/status" });
  assertAllowed("prompt.submit", { session_id: "s", input_id: "i", text: "x" });
});
