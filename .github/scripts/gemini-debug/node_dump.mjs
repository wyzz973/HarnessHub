// Debug-only: open the inspector of a running Node process (process._debugProcess, which works
// on Windows), then record its libuv handles/requests via process.report and try to pause it to
// capture the JavaScript stack. A main thread blocked in native code (for example spawnSync)
// cannot answer, which is itself recorded.
// Usage: node node_dump.mjs PID OUT_JSON [PORT]
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const [pidText, out, portText] = process.argv.slice(2);
const pid = Number(pidText);
const port = Number(portText ?? 9229);
const result = { pid, at: new Date().toISOString() };
const save = () => writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
try {
  process._debugProcess(pid);
  result.debugProcess = "ok";
} catch (error) {
  result.debugProcess = String(error);
  save();
  process.exit(0);
}
let target;
for (let attempt = 0; attempt < 20 && !target; attempt++) {
  await delay(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list[0];
  } catch {}
}
if (!target) {
  result.inspector = "no inspector target on port";
  save();
  process.exit(0);
}
result.target = { title: target.title, url: target.url };
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let id = 0;
const pending = new Map();
const events = [];
socket.addEventListener("message", (message) => {
  const data = JSON.parse(String(message.data));
  if (data.id && pending.has(data.id)) {
    pending.get(data.id)(data);
    pending.delete(data.id);
  } else events.push(data);
});
const call = (method, params = {}, timeoutMs = 15_000) =>
  new Promise((resolve) => {
    const callId = ++id;
    const timer = setTimeout(() => {
      pending.delete(callId);
      resolve({ timedOut: true });
    }, timeoutMs);
    pending.set(callId, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
    socket.send(JSON.stringify({ id: callId, method, params }));
  });

const report = await call("Runtime.evaluate", {
  expression: "JSON.stringify({report: process.report.getReport(), handles: process._getActiveHandles().map(h => h.constructor && h.constructor.name), requests: process._getActiveRequests().map(r => r.constructor && r.constructor.name)})",
  returnByValue: true,
});
if (report.timedOut) result.report = "Runtime.evaluate timed out: main thread does not run JavaScript";
else {
  try {
    const parsed = JSON.parse(report.result.result.value);
    result.activeHandles = parsed.handles;
    result.activeRequests = parsed.requests;
    result.libuv = parsed.report.libuv;
    result.nativeStack = parsed.report.nativeStack;
    result.header = { cwd: parsed.report.header.cwd, commandLine: parsed.report.header.commandLine };
  } catch (error) {
    result.report = `unparsable: ${String(error)} ${JSON.stringify(report).slice(0, 500)}`;
  }
}
await call("Debugger.enable");
const paused = new Promise((resolve) => {
  const timer = setTimeout(() => resolve(undefined), 20_000);
  const check = setInterval(() => {
    const event = events.find((item) => item.method === "Debugger.paused");
    if (event) {
      clearTimeout(timer);
      clearInterval(check);
      resolve(event);
    }
  }, 100);
});
await call("Debugger.pause");
const event = await paused;
if (event) {
  result.pausedStack = event.params.callFrames.map((frame) => `${frame.functionName || "<anon>"} ${frame.url.split("/").slice(-2).join("/")}:${frame.location.lineNumber + 1}`);
  const asyncTrace = [];
  for (let trace = event.params.asyncStackTrace; trace; trace = trace.parent)
    asyncTrace.push(`${trace.description}: ${trace.callFrames.map((frame) => `${frame.functionName || "<anon>"} ${frame.url.split("/").slice(-1)[0]}:${frame.lineNumber + 1}`).join(" <- ")}`);
  result.asyncStack = asyncTrace;
  await call("Debugger.resume");
} else result.pausedStack = "no Debugger.paused within 20 s";
await call("Debugger.disable");
await call("Runtime.evaluate", { expression: "process._debugEnd && process._debugEnd()" }, 3000);
socket.close();
save();
process.exit(0);
