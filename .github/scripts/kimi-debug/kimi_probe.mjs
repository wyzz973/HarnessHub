// Debug-only: run kimi.exe the way the HarnessHub CLI Driver does (argv prompt, piped stdio)
// against a tiny OpenAI-compatible streaming stub, and record the exact stdout bytes.
// It shows which encoding Kimi uses for a piped stdout, that PYTHON* variables are ignored
// by the frozen executable, and what the patched executable writes instead.
// Usage: node kimi_probe.mjs ORIGINAL_EXE PATCHED_EXE OUT
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const [original, patched, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const logFile = path.join(out, "kimi-probe.jsonl");
const replies = {
  ascii: "OK",
  latin1: "café",
  cjk: "中文回复：完成 ✅ café 🎉",
};
let requests = 0;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (request.method !== "POST") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "stub", object: "model" }] }));
    return;
  }
  requests += 1;
  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {}
  const user = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
  const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
  const key = Object.keys(replies).find((name) => text.includes(`REPLY:${name}`)) ?? "ascii";
  const frame = (delta, finish = null, extra = {}) =>
    `data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model: body.model ?? "stub", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(frame({ role: "assistant", content: replies[key] }));
  response.write(frame({}, "stop", { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const config = path.join(out, "kimi.json");
writeFileSync(
  config,
  JSON.stringify({
    default_model: "stub",
    default_thinking: false,
    telemetry: false,
    merge_all_available_skills: false,
    providers: { harnesshub: { type: "openai_legacy", base_url: base, api_key: "" } },
    models: { stub: { provider: "harnesshub", model: "stub", max_context_size: 131072 } },
    loop_control: { reserved_context_size: 8192 },
  }),
);

let index = 0;
async function run(label, exe, reply, extraEnv = {}) {
  index += 1;
  const work = path.join(out, `work-${index}`);
  mkdirSync(work, { recursive: true });
  const before = requests;
  const begin = Date.now();
  const child = spawn(
    exe,
    ["--quiet", "--prompt", `REPLY:${reply} say the configured line`, "--model", "stub", "--config-file", config],
    {
      cwd: work,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        KIMI_SHARE_DIR: path.join(out, `share-${index}`),
        KIMI_DISABLE_TELEMETRY: "1",
        KIMI_CLI_NO_AUTO_UPDATE: "1",
        OPENAI_BASE_URL: base,
        OPENAI_API_KEY: "stub-key",
        ...extraEnv,
      },
    },
  );
  child.stdin.end();
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve({ timedOut: true });
    }, 180_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  const bytes = Buffer.concat(stdout);
  const record = {
    label,
    reply,
    expected: replies[reply],
    env: Object.keys(extraEnv),
    exit,
    ms: Date.now() - begin,
    modelRequests: requests - before,
    stdoutHex: bytes.subarray(0, 96).toString("hex"),
    stdoutAsUtf8: bytes.toString("utf8").trim(),
    stdoutAsLatin1: bytes.toString("latin1").trim(),
    intactAsUtf8: bytes.toString("utf8").trim() === replies[reply],
    stderrTail: Buffer.concat(stderr).toString("utf8").trim().split(/\r?\n/).filter((line) => !line.startsWith("To resume")).slice(-3).join(" | ").slice(0, 400),
  };
  console.log(JSON.stringify(record));
  appendFileSync(logFile, `${JSON.stringify(record)}\n`);
}

const pythonEnv = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
await run("original", original, "ascii");
await run("original", original, "latin1");
await run("original", original, "cjk");
await run("original+PYTHONUTF8+PYTHONIOENCODING", original, "latin1", pythonEnv);
await run("original+PYTHONUTF8+PYTHONIOENCODING", original, "cjk", pythonEnv);
await run("original+PYTHONLEGACYWINDOWSSTDIO", original, "cjk", { PYTHONLEGACYWINDOWSSTDIO: "1" });
await run("patched", patched, "ascii");
await run("patched", patched, "latin1");
await run("patched", patched, "cjk");
server.close();
