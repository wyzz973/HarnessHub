import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
let active = null, counter = 0, nativeModel = null;
const native = "browser-native-" + process.pid;
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
createInterface({ input: process.stdin }).on("line", line => {
  const value = JSON.parse(line);
  if (value.id === "browser-approval" && value.result !== undefined && active?.approval) {
    notify("item/agentMessage/delta", { threadId: native, turnId: active.id, itemId: "browser-message", delta: "原生审批已收到：" + value.result.decision });
    notify("turn/completed", { threadId: native, turn: { id: active.id, status: "completed" } }); active = null; return;
  }
  if (value.method === "initialize") return reply(value.id, { userAgent: "browser-external-peer/1.0" });
  if (value.method === "initialized") return;
  if (value.method === "config/read") return reply(value.id, { config: { model: "native-a" } });
  if (value.method === "account/read") return reply(value.id, { account: { type: "chatgpt" }, requiresOpenaiAuth: true });
  if (value.method === "model/list") return reply(value.id, { data: [{ model: "native-a", displayName: "Native A", defaultReasoningEffort:"low",supportedReasoningEfforts:[{reasoningEffort:"low"},{reasoningEffort:"high"}] }, { model: "native-b", displayName: "Native B", defaultReasoningEffort:"low",supportedReasoningEfforts:[{reasoningEffort:"low"},{reasoningEffort:"high"}] }], nextCursor: null });
  if (value.method === "thread/start") { nativeModel = value.params.model ?? null; notify("thread/started", { thread: { id: native } }); return reply(value.id, { thread: { id: native } }); }
  if (value.method === "turn/start") {
    const context = JSON.parse(value.params.input[0].text.split("\n").slice(1).join("\n"));
    const text = context.currentInput.text;
    const config = process.env.HARNESS_GATEWAY_PROVIDER_KEY ? readFileSync(join(process.env.CODEX_HOME, "config.toml"), "utf8") : null;
    const model = nativeModel ?? (config ? JSON.parse(config.match(/^model = (.+)$/mu)[1]) : "native-a");
    active = { id: "browser-turn-" + ++counter };
    notify("turn/started", { threadId: native, turn: { id: active.id, status: "inProgress" } }); reply(value.id, { turn: { id: active.id, status: "inProgress" } });
    if (text.startsWith("APPROVAL")) {
      active.approval = true;
      send({ id: "browser-approval", method: "item/commandExecution/requestApproval", params: { threadId: native, turnId: active.id, itemId: "fixture-command", command: "读取验收工作区", availableDecisions: ["accept", "decline", "cancel"] } }); return;
    }
    if (text.startsWith("STREAM_RENDER") || text.startsWith("STREAM_CANCEL")) {
      const emit = delta => notify("item/agentMessage/delta", { threadId: native, turnId: active.id, itemId: "browser-message", delta });
      let phase = "first";
      active.watcher = watch(process.cwd(), (_event, filename) => {
        if (filename !== "stream-control.json" || active === null) return;
        let command;
        try { command = JSON.parse(readFileSync(join(process.cwd(), "stream-control.json"), "utf8")); }
        catch (error) { if (error.code === "ENOENT") return; throw error; }
        if (command.stage === "second" && phase === "first") {
          phase = "second";
          emit('tial";\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| SSE | 进行中 |\n\n第二段正在生成。');
        } else if (command.stage === "finish") {
          active.watcher.close();
          emit("\n\n第三段完成。<script>window.__unsafeChatScript=true</script>\n\n![外部图片](https://example.invalid/chat-image.png)");
          notify("turn/completed", { threadId: native, turn: { id: active.id, status: "completed" } }); active = null;
        }
      });
      const paragraphs = Array.from({ length: 22 }, (_, index) => `实际到达的内容 ${index + 1}：这段内容用于验证阅读位置保持，用户查看前面的消息时，继续生成不会将视图拉到底部。`).join("\n\n");
      emit('第一段已经到达。\n\n'+paragraphs+'\n\n## 流式标题\n\n```typescript\nconst answer = "par');
      return;
    }
    const answer = `已由 **${model}** 处理：${text}\n\n这是浏览器验收使用的外部 Harness 对端。公共历史包含 ${context.history.length} 轮。`;
    // Deliberately split the synthetic injected key across chunks to verify the actual wrapper.
    const key = process.env.HARNESS_GATEWAY_PROVIDER_KEY ?? "";
    const output = answer + "\n\n凭据过滤验证：" + key;
    const split = output.length - Math.floor(key.length / 2);
    for (const delta of [output.slice(0, split), output.slice(split)]) notify("item/agentMessage/delta", { threadId: native, turnId: active.id, itemId: "browser-message", delta });
    if (!text.includes("等待取消")) {
      const failOnce = text.startsWith("FAIL_ONCE") && !existsSync(join(process.cwd(), "failed-once.txt"));
      if (failOnce) writeFileSync(join(process.cwd(), "failed-once.txt"), "external fixture failed one reply\n");
      notify("turn/completed", { threadId: native, turn: { id: active.id, status: failOnce ? "failed" : "completed" } }); active = null;
    }
    return;
  }
  if (value.method === "turn/interrupt") { active?.watcher?.close(); reply(value.id, {}); if (active) notify("turn/completed", { threadId: native, turn: { id: active.id, status: "interrupted" } }); active = null; }
});
