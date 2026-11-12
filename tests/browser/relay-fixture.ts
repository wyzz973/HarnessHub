import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";

/*
 * The real Gateway over a private data directory with Claude Code and Codex available, each run by a fixture that plays what its protocol shows of the native side
 * (tests/fixtures/relay-control-peer.mjs), for the browser tests that walk the page against it (relay-e2e, composer). Only the two Harnesses' own programs are fixtures; every
 * line the Gateway sent either is kept in a trace, which is how a test sees what did and did not reach a native side. `mode` is what Codex's fixture does at its next start:
 * `echoDelayMs` shows the user's message that late (a Turn held visibly under way), `catalogDelayMs` answers its configuration read that late (the model catalog arrives late),
 * and the peer's own RELAY_* settings by name.
 */

const peer = pathToFileURL(fileURLToPath(new URL("../../../tests/fixtures/relay-control-peer.mjs", import.meta.url))).href;
export const CLAUDE_REPLY = "Claude Code：收到，我来处理。", CODEX_REPLY = "Codex：收到，接着做。";

export interface Fixture { readonly root: string; readonly gateway: WebServer; readonly mode: (value: Readonly<Record<string, string | number>>) => Promise<void>; close(): Promise<void> }
/**
 * The real Gateway over a private data directory and workspace. Claude Code's and Codex's catalog entries run these programs instead of
 * the installed ones: Claude Code's keeps its transcript where the Driver reads it (the home the Gateway gives its Harnesses); Codex's
 * reads `mode` at each start (what its native side does at the next Turn: the default, or no echo of the user's message, which is all
 * a Driver that can only be told by that echo has to go by), and with `echoDelayMs` shows a user message that late, which keeps a
 * hand-over visibly on its way. Both write what they were sent to a trace in the private home.
 */
export async function launch(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-relay-e2e-"))), workspace = join(root, "workspace");
  await mkdir(workspace);
  const state = join(root, "native-state.json"), modeFile = join(root, "codex-mode.json"), claudeShim = join(root, "claude-fixture.mjs"), codexShim = join(root, "codex-fixture.mjs"), codexPeer = join(root, "codex-peer.mjs");
  await writeFile(modeFile, "{}");
  const commands = JSON.stringify([{ name: "compact", description: "Clear conversation history but keep a summary" }, { name: "context", description: "Show current context usage" }]);
  // Claude Code: the transcript is the CLI's, in the Gateway's home for its Harnesses (CLAUDE_CONFIG_DIR is not set, so ~/.claude of that home).
  await writeFile(claudeShim, "#!" + process.execPath + "\n" + [
    `process.env.RELAY_PROTOCOL = "acp"; process.env.RELAY_STATE = ${JSON.stringify(state)}; process.env.RELAY_TRANSCRIPT = ${JSON.stringify(join(root, ".claude"))};`,
    `process.env.RELAY_REPLY = ${JSON.stringify(CLAUDE_REPLY)}; process.env.RELAY_COMMANDS = ${JSON.stringify(commands)}; process.env.RELAY_TRACE = ${JSON.stringify(join(root, "claude-trace.jsonl"))};`,
    `await import(${JSON.stringify(peer)});`, ""].join("\n"), { mode: 0o700 });
  // Codex: the same fixture, behind a proxy that holds the whole Turn back when the mode says so (the order of what it says is kept).
  await writeFile(codexPeer, `import { readFileSync } from "node:fs";\nconst mode = JSON.parse(readFileSync(${JSON.stringify(modeFile)}, "utf8"));\n`
    + `Object.assign(process.env, { RELAY_PROTOCOL: "codex", RELAY_STATE: ${JSON.stringify(state)}, RELAY_REPLY: ${JSON.stringify(CODEX_REPLY)}, RELAY_ECHO_FIELD: "clientId", RELAY_TRACE: ${JSON.stringify(join(root, "codex-trace.jsonl"))} }, Object.fromEntries(Object.entries(mode).map(([key, value]) => [key, String(value)])));\n`
    + `await import(${JSON.stringify(peer)});\n`);
  await writeFile(codexShim, "#!" + process.execPath + "\n" + [
    `import { spawn } from "node:child_process"; import { readFileSync } from "node:fs"; import { createInterface } from "node:readline";`,
    `const mode = JSON.parse(readFileSync(${JSON.stringify(modeFile)}, "utf8")), delay = Number(mode.echoDelayMs ?? 0), catalog = Number(mode.catalogDelayMs ?? 0);`,
    `const child = spawn(process.execPath, [${JSON.stringify(codexPeer)}], { stdio: ["pipe", "pipe", "inherit"] });`,
    `const methods = new Map();`,
    `createInterface({ input: process.stdin }).on("line", line => {`,
    `  try { const message = JSON.parse(line); if (message.id !== undefined && typeof message.method === "string") methods.set(message.id, message.method); } catch { /* not JSON */ }`,
    `  child.stdin.write(line + "\\n");`,
    `}).on("close", () => child.stdin.end());`,
    `let chain = Promise.resolve();`,
    `createInterface({ input: child.stdout }).on("line", line => {`,
    `  let wait = 0;`,
    `  try {`,
    `    const message = JSON.parse(line);`,
    `    if (delay > 0 && message.method === "item/started" && message.params?.item?.type === "userMessage") wait = delay;`,
    `    if (catalog > 0 && message.id !== undefined && methods.get(message.id) === "config/read") wait = catalog;`,
    `  } catch { /* not JSON */ }`,
    `  chain = chain.then(async () => { if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait)); process.stdout.write(line + "\\n"); });`,
    `});`,
    `child.on("exit", code => chain.then(() => process.exit(code ?? 0)));`, ""].join("\n"), { mode: 0o700 });
  const manifest = join(root, "catalog.json");
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [], overrides: { "claude-acp-npm": { executable: claudeShim }, "codex-native": { executable: codexShim } } }));
  let gateway: WebServer;
  try {
    gateway = await startWebServer({ root: join(root, "data"), configuration: await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true }), port: 0, providerManagement: false,
      // The Harnesses are manifest entries, which only a development Gateway reads (ADR-044); their home is the private one.
      application: (data, publish) => application(data, publish, { installations: "any", nativeEnvironment: { home: root, values: { HOME: root, PATH: dirname(process.execPath) + ":/usr/bin:/bin" } }, workspaceLockRoot: join(root, "locks") }) });
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  return { root, gateway, mode: async value => { await writeFile(modeFile, JSON.stringify(value)); }, close: async () => { try { await gateway.close(); } finally { await rm(root, { recursive: true, force: true }); } } };
}

/** What a native side was sent: every line of its trace, in order. */
export async function sent(root: string, harness: "claude" | "codex"): Promise<readonly { readonly method?: string; readonly params?: Record<string, unknown> }[]> {
  try { return (await readFile(join(root, harness + "-trace.jsonl"), "utf8")).split("\n").filter(line => line.length > 0).map(line => JSON.parse(line)); } catch { return []; }
}
/** The text each prompt carried to the native side, in order (Claude Code's blocks joined as its transcript shows them, Codex's single text). */
export async function prompts(root: string, harness: "claude" | "codex"): Promise<readonly string[]> {
  const lines = await sent(root, harness);
  if (harness === "codex") return lines.filter(line => line.method === "turn/start").map(line => (line.params!.input as { text: string }[])[0]!.text);
  return lines.filter(line => line.method === "session/prompt").map(line => (line.params!.prompt as { type: string; text: string }[]).filter(block => block.type === "text").map(block => block.text).join("\n"));
}
/**
 * How many native sessions the Gateway has put a Turn in on that side (a clear gives the old one up for a new one): the threads it
 * started for Codex, the distinct sessions it prompted for Claude Code (its catalog reads open sessions of their own, which no Turn is in).
 */
export async function opened(root: string, harness: "claude" | "codex"): Promise<number> {
  const lines = await sent(root, harness);
  if (harness === "codex") return lines.filter(line => line.method === "thread/start").length;
  return new Set(lines.filter(line => line.method === "session/prompt").map(line => line.params!.sessionId)).size;
}

