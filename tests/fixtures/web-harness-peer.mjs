import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { readRelayPrompt } from "../../dist/tests/fixtures/relay-packet.js";
let active = null, counter = 0, nativeModel = null;
let native = "browser-native-" + process.pid;
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
// The requests this fixture answers; any other request is refused as a real app-server refuses a method it does not have.
const ANSWERED = new Set(["initialize", "config/read", "account/read", "model/list", "skills/list", "mcpServerStatus/list", "plugin/installed", "thread/start", "thread/fork", "thread/resume", "turn/start", "turn/interrupt"]);
createInterface({ input: process.stdin }).on("line", line => {
  const value = JSON.parse(line);
  if (value.id !== undefined && typeof value.method === "string" && !ANSWERED.has(value.method)) { send({ id: value.id, error: { code: -32601, message: "Method not found: " + value.method } }); return; }
  if (value.id === "browser-approval" && value.result !== undefined && active?.approval) {
    notify("item/agentMessage/delta", { threadId: native, turnId: active.id, itemId: "browser-message", delta: "原生审批已收到：" + value.result.decision });
    notify("turn/completed", { threadId: native, turn: { id: active.id, status: "completed" } }); active = null; return;
  }
  if (value.method === "initialize") return reply(value.id, { userAgent: "browser-external-peer/1.0" });
  if (value.method === "initialized") return;
  if (value.method === "config/read") return reply(value.id, { config: { model: "native-a" } });
  if (value.method === "account/read") return reply(value.id, { account: { type: "chatgpt" }, requiresOpenaiAuth: true });
  if (value.method === "model/list") return reply(value.id, { data: [{ model: "native-a", displayName: "Native A", defaultReasoningEffort:"low",supportedReasoningEfforts:[{reasoningEffort:"low"},{reasoningEffort:"high"}] }, { model: "native-b", displayName: "Native B", defaultReasoningEffort:"low",supportedReasoningEfforts:[{reasoningEffort:"low"},{reasoningEffort:"high"}] }], nextCursor: null });
  if (value.method === "skills/list") return reply(value.id, { data: [{ cwd: process.cwd(), skills: [{ name: "browser-skill", description: "浏览器验收技能", path: "/skills/browser-skill/SKILL.md", scope: "user", enabled: true }], errors: [] }] });
  if (value.method === "mcpServerStatus/list") return reply(value.id, { data: [{ name: "browser-docs", runtimeStatus: "connected", authStatus: "unsupported", tools: { lookup: {} }, toolsError: null }], nextCursor: null });
  if (value.method === "plugin/installed") return reply(value.id, { marketplaces: [{ name: "browser-market", plugins: [{ name: "browser-plugin", installed: true, enabled: true, localVersion: "2.0.0" }] }], marketplaceLoadErrors: [] });
  // As a real app-server does, the thread reports the approval policy and sandbox it runs with (the ones asked for, else Codex's own).
  const settings = params => ({ approvalPolicy: params.approvalPolicy ?? "on-request", sandbox: { type: { "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess" }[params.sandbox ?? "workspace-write"] } });
  if (value.method === "thread/start") { nativeModel = value.params.model ?? null; notify("thread/started", { thread: { id: native } }); return reply(value.id, { thread: { id: native }, ...settings(value.params) }); }
  if (value.method === "thread/fork") { const id = "browser-fork-" + process.pid; notify("thread/started", { thread: { id } }); return reply(value.id, { thread: { id } }); }
  if (value.method === "thread/resume") { native = value.params.threadId; nativeModel = value.params.model ?? null; notify("thread/started", { thread: { id: native } }); return reply(value.id, { thread: { id: native }, ...settings(value.params) }); }
  if (value.method === "turn/start") {
    const input = value.params.input[0].text;
    // File pointers follow the user's words, after the relay packet's end line; they are not part of either.
    const envelope = input.replace(/\n\n\[Attached file\][^]*$/u, "");
    const context = readRelayPrompt(envelope);
    const text = context.currentInput.text;
    const config = process.env.HARNESS_GATEWAY_PROVIDER_KEY ? readFileSync(join(process.env.CODEX_HOME, "config.toml"), "utf8") : null;
    const model = nativeModel ?? (config ? JSON.parse(config.match(/^model = (.+)$/mu)[1]) : "native-a");
    active = { id: "browser-turn-" + ++counter };
    notify("turn/started", { threadId: native, turn: { id: active.id, status: "inProgress" } }); reply(value.id, { turn: { id: active.id, status: "inProgress" } });
    const skill = value.params.input.find(item => item.type === "skill");
    if (skill) {
      notify("item/agentMessage/delta", { threadId: native, turnId: active.id, itemId: "browser-message", delta: "已使用技能 " + skill.name + "：" + input });
      notify("turn/completed", { threadId: native, turn: { id: active.id, status: "completed" } }); active = null; return;
    }
    if (text.startsWith("WHICH_THREAD")) {
      // Names the native thread this Turn ran on, so a branch can be seen continuing in its own native copy.
      notify("item/agentMessage/delta", { threadId: native, turnId: active.id, itemId: "browser-message", delta: (native.startsWith("browser-fork-") ? "原生分支线程" : "原线程") + "，公共历史 " + context.history.length + " 轮，分支历史 " + (context.branchedHistory?.length ?? 0) + " 条" });
      notify("turn/completed", { threadId: native, turn: { id: active.id, status: "completed" } }); active = null; return;
    }
    if (text.startsWith("ATTACHMENTS")) {
      // Images arrive as localImage paths, files as text pointers; the reply proves the private copies are readable.
      const images = value.params.input.slice(1).filter(item => item.type === "localImage"), files = [...input.matchAll(/^\[Attached file\] (.+?) \(.+\): (\/.+)$/gmu)];
      const readable = [...images.map(item => item.path), ...files.map(match => match[2])].every(path => existsSync(path));
      notify("item/agentMessage/delta", { threadId: native, turnId: active.id, itemId: "browser-message", delta: `收到附件：图片 ${images.length}，文件 ${files.length}，${readable ? "均可读" : "存在不可读文件"}。` });
      notify("turn/completed", { threadId: native, turn: { id: active.id, status: "completed" } }); active = null; return;
    }
    if (text.startsWith("NATIVE_ACTIVITY")) {
      const base = { threadId: native, turnId: active.id };
      notify("turn/plan/updated", { ...base, explanation: "浏览器验收计划", plan: [{ step: "读取工作区", status: "completed" }, { step: "修改文件", status: "inProgress" }] });
      notify("item/started", { ...base, item: { type: "commandExecution", id: "browser-cmd", command: "ls -la", cwd: process.cwd(), status: "inProgress" } });
      notify("item/commandExecution/outputDelta", { ...base, itemId: "browser-cmd", delta: "total 0\n" });
      notify("item/completed", { ...base, item: { type: "commandExecution", id: "browser-cmd", command: "ls -la", cwd: process.cwd(), status: "completed", aggregatedOutput: "total 0\nREADME.md\n", exitCode: 0 } });
      notify("item/completed", { ...base, item: { type: "fileChange", id: "browser-patch", status: "completed", changes: [{ path: "README.md", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-旧内容\n+新内容\n" }] } });
      notify("warning", { threadId: native, message: "浏览器验收提示" });
      notify("thread/tokenUsage/updated", { ...base, tokenUsage: { total: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 0, outputTokens: 300, reasoningOutputTokens: 0 }, last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 0, outputTokens: 300, reasoningOutputTokens: 0 }, modelContextWindow: 10000 } });
      notify("item/agentMessage/delta", { ...base, itemId: "browser-message", delta: "原生活动已完成。" });
      notify("turn/completed", { threadId: native, turn: { id: active.id, status: "completed" } }); active = null; return;
    }
    if (text.startsWith("APPROVAL")) {
      active.approval = true;
      send({ id: "browser-approval", method: "item/commandExecution/requestApproval", params: { threadId: native, turnId: active.id, itemId: "fixture-command", command: "读取验收工作区", availableDecisions: ["accept", "decline", "cancel"] } }); return;
    }
    if (text.startsWith("STREAM_BLOCK")) {
      // A reply that ends with a code block, finished when the stream-control file says so: its end dot stands on a line of its own.
      const emit = delta => notify("item/agentMessage/delta", { threadId: native, turnId: active.id, itemId: "browser-message", delta });
      active.watcher = watch(process.cwd(), (_event, filename) => {
        if (filename !== "stream-control.json" || active === null) return;
        let command;
        try { command = JSON.parse(readFileSync(join(process.cwd(), "stream-control.json"), "utf8")); }
        catch (error) { if (error.code === "ENOENT") return; throw error; }
        if (command.stage !== "finish") return;
        active.watcher.close();
        emit("\n```");
        notify("turn/completed", { threadId: native, turn: { id: active.id, status: "completed" } }); active = null;
      });
      const paragraphs = Array.from({ length: 16 }, (_, index) => `段落 ${index + 1}：这段内容让对话长过一屏，回复写完时页面仍然停在最新的位置。`).join("\n\n");
      emit(paragraphs + "\n\n最后运行：\n\n```sh\npnpm test");
      return;
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
