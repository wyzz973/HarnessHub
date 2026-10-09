import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
let active = null, counter = 0;
const native = "browser-native-" + process.pid;
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
createInterface({ input: process.stdin }).on("line", line => {
  const value = JSON.parse(line);
  if (value.method === "initialize") return reply(value.id, { userAgent: "browser-external-peer/1.0" });
  if (value.method === "initialized") return;
  if (value.method === "thread/start") { notify("thread/started", { thread: { id: native } }); return reply(value.id, { thread: { id: native } }); }
  if (value.method === "turn/start") {
    const context = JSON.parse(value.params.input[0].text.split("\n").slice(1).join("\n"));
    const text = context.currentInput.text;
    const config = readFileSync(join(process.env.CODEX_HOME, "config.toml"), "utf8");
    const model = JSON.parse(config.match(/^model = (.+)$/mu)[1]);
    active = { id: "browser-turn-" + ++counter };
    notify("turn/started", { threadId: native, turn: { id: active.id, status: "inProgress" } }); reply(value.id, { turn: { id: active.id, status: "inProgress" } });
    const answer = `已由 **${model}** 处理：${text}\n\n这是浏览器验收使用的外部 Harness 对端。公共历史包含 ${context.history.length} 轮。`;
    // Deliberately split the synthetic injected key across chunks to verify the actual wrapper.
    const key = process.env.HARNESS_GATEWAY_PROVIDER_KEY ?? "";
    const output = answer + "\n\n凭据过滤验证：" + key;
    const split = output.length - Math.floor(key.length / 2);
    for (const delta of [output.slice(0, split), output.slice(split)]) notify("item/agentMessage/delta", { threadId: native, turnId: active.id, itemId: "browser-message", delta });
    if (!text.includes("等待取消")) { notify("turn/completed", { threadId: native, turn: { id: active.id, status: "completed" } }); active = null; }
    return;
  }
  if (value.method === "turn/interrupt") { reply(value.id, {}); if (active) notify("turn/completed", { threadId: native, turn: { id: active.id, status: "interrupted" } }); active = null; }
});
