import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

// A Harness over ACP that changes files of its workspace (its working folder) as its prompt says, for the checkpoint tests. The prompt's last line holds the words:
// `write:<path>=<text>` writes <text> and a newline, `delete:<path>` deletes a file, `hold` keeps the Turn running until it is cancelled. Whatever the Hub puts before
// the user's words (its notes, a relay packet) is above that line.
let active = null;
const nativeId = "checkpoint-native-" + process.pid;
function emit(value) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n"); }
function finish(cancelled) { emit({ id: active, result: { stopReason: cancelled ? "cancelled" : "end_turn" } }); active = null; }
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") { emit({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: "checkpoint", version: "1.0" } } }); return; }
  if (message.method === "session/new") { emit({ id: message.id, result: { sessionId: nativeId } }); return; }
  if (message.method === "session/prompt") {
    const prompt = String(message.params.prompt[0].text), words = prompt.trimEnd().split("\n").at(-1).split(/\s+/u);
    for (const word of words) {
      const write = /^write:([^=]+)=(.*)$/u.exec(word), gone = /^delete:(.+)$/u.exec(word);
      if (write) { const path = join(process.cwd(), write[1]); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, write[2] + "\n"); }
      if (gone) rmSync(join(process.cwd(), gone[1]), { force: true });
    }
    active = message.id;
    emit({ method: "session/update", params: { sessionId: nativeId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done: " + words.join(" ") } } } });
    if (!words.includes("hold")) finish(false);
    return;
  }
  if (message.method === "session/cancel") { if (active !== null) finish(true); return; }
  if (message.id !== undefined && typeof message.method === "string") emit({ id: message.id, error: { code: -32601, message: "method not found" } });
});
