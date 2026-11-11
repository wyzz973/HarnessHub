import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import type { ControlEvent, ControlLaunch, ControlOptions, HarnessControl, TurnText } from "../../src/contracts/control.js";
import { relayPacketId, type RelayPacketId } from "../../src/contracts/relay.js";
import { AcpControl, dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { ClaudeControl } from "../../src/adapters/control/claude.js";
import { CodexControl } from "../../src/adapters/control/codex.js";
import { HermesControl } from "../../src/adapters/control/hermes.js";
import { OpenClawControl } from "../../src/adapters/control/openclaw.js";
import { OpenCodeControl } from "../../src/adapters/control/opencode.js";

// The six Drivers on the relay peer (tests/fixtures/relay-control-peer.mjs) as real child processes, each in a private
// temporary root; OpenClaw's Gateway calls are answered from the peer's own state file, as the Gateway reads what the bridge
// stored. Nothing here runs a Harness or reads a user's configuration.

export type Harness = "claude" | "codex" | "opencode" | "dsh" | "hermes" | "openclaw";
const PEER = resolve("tests/fixtures/relay-control-peer.mjs");
export const ID_A = relayPacketId("relay-0123456789abcdefghjk"), ID_B = relayPacketId("relay-mnpqrstvwxyz01234567"), ID_C = relayPacketId("relay-7777777777aaaaaaaaaa");

/** A packet in the renderer's frame (packet.ts): the user's first line when given, the title line, the record, the end line. */
export function packet(id: RelayPacketId, first?: string): string {
  return (first === undefined ? "" : first + "\n") + "〔HarnessHub 交接单 " + id + "〕\n这段对话前面的部分不在你的上下文里：Codex 在同一个工作区里做过下面这些事。\n\n## 用户原话\n- 第 1 轮（开场请求）：\n  修好测试\n\n〔记录结束 · " + id + "。以下是用户现在的指令（原话）〕";
}
/** A relay Turn: the user's words and a packet that starts with their first line unless `firstLine` is false. */
export function relayTurn(id: RelayPacketId, user: string, firstLine = true): Exclude<TurnText, string> {
  return { user, relay: { packetId: id, body: packet(id, firstLine ? user.split("\n")[0] : undefined), firstLine } };
}
export interface Peer {
  readonly root: string;
  readonly workspace: string;
  readonly state: string;
  readonly trace: string;
  readonly env: Readonly<Record<string, string>>;
  /** The messages the peer received, in order. */
  sent(): Promise<readonly { readonly method?: string; readonly params?: Record<string, unknown>; readonly id?: unknown }[]>;
  /** The peer's native state (sessions and threads). */
  native(): Promise<{ readonly sessions: Record<string, { readonly entries: readonly Record<string, unknown>[]; readonly title: string | null }>; readonly threads: Record<string, { readonly turns: readonly Record<string, unknown>[]; readonly name: string | null }> }>;
}
/** A private root with a workspace, the peer's state file and its trace; removed after the test. */
export async function peerRoot(t: TestContext, env: Readonly<Record<string, string>> = {}): Promise<Peer> {
  const root = await mkdtemp(join(tmpdir(), "g069-driver-")); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), state = join(root, "state.json"), trace = join(root, "trace.ndjson");
  await import("node:fs/promises").then(fs => fs.mkdir(workspace));
  const all = { HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"), OPENCLAW_CONFIG_PATH: join(root, "openclaw.json"), DSH_HOME: join(root, "dsh"),
    XDG_CONFIG_HOME: join(root, "xdg"), RELAY_STATE: state, RELAY_TRACE: trace, ...env };
  return { root, workspace, state, trace, env: all,
    sent: async () => { try { return (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } },
    native: async () => { try { return JSON.parse(await readFile(state, "utf8")); } catch { return { sessions: {}, threads: {} }; } } };
}
export function options(peer: Peer, overrides: Partial<ControlOptions> = {}): ControlOptions {
  return { cwd: peer.workspace, env: peer.env, requestTimeoutMs: 3000, runTimeoutMs: 8000, maxFrameBytes: 4 << 20, maxDiagnosticBytes: 1 << 14, closeGraceMs: 150, ...overrides };
}
/** OpenClaw's Gateway as the driver's original CLI reads it: the bridge's stored rows of the one session. */
export function gatewayOf(peer: Peer, overrides: Partial<Record<string, (params: Readonly<Record<string, unknown>>) => Promise<unknown>>> = {}) {
  return async (method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> => {
    const override = overrides[method];
    if (override !== undefined) return override(params);
    const native = await peer.native(), owned = Object.values(native.sessions)[0];
    if (method === "agents.list") return { defaultId: "main", agents: [{ id: "main" }] };
    if (method === "models.list") return { models: [] };
    if (method === "sessions.list") return { sessions: [] };
    if (method === "chat.history") return { messages: [] };
    if (method === "sessions.get") {
      const entries = owned?.entries ?? [], limit = typeof params.limit === "number" ? params.limit : 200;
      return { messages: entries.slice(-limit).map(entry => ({ role: entry.role, content: entry.role === "user" ? entry.text : [{ type: "text", text: entry.text }], ...(entry.usage === undefined ? {} : { usage: entry.usage }), __openclaw: { seq: entry.seq } })) };
    }
    throw new Error("unexpected OpenClaw method " + method);
  };
}
/** A Driver of `harness` on the relay peer; closed after the test. */
export function driver(t: TestContext, harness: Harness, peer: Peer, gateway = gatewayOf(peer), overrides: Partial<ControlOptions> = {}): HarnessControl {
  const env = { ...peer.env, ...(harness === "codex" ? { RELAY_PROTOCOL: "codex" } : {}) };
  const launch: ControlLaunch = { protocol: harness === "codex" ? "codex-app-server" : "acp-v1", executable: process.execPath, args: [PEER, ...(harness === "openclaw" ? ["acp"] : [])], env };
  const settings = options(peer, overrides);
  const control = harness === "claude" ? new ClaudeControl(launch, settings) : harness === "codex" ? new CodexControl(launch, settings) : harness === "opencode" ? new OpenCodeControl(launch, settings)
    : harness === "hermes" ? new HermesControl(launch, settings, async () => ({ kind: "attach", verdict: "A", explanation: "fixture gateway", evidence: [] }))
    : harness === "openclaw" ? new OpenClawControl(launch, settings, gateway) : new AcpControl(launch, settings, dshRelayCapabilities);
  t.after(() => control.close().then(() => undefined, () => undefined));
  return control;
}
/** Runs one Turn and returns its result with the events it reported. */
export async function run(control: HarnessControl, id: Parameters<HarnessControl["startText"]>[0], text: TurnText, attachments: Parameters<HarnessControl["startText"]>[3] = []) {
  const events: ControlEvent[] = [];
  const started = await control.startText(id, text, event => events.push(event), attachments);
  return { result: await started.result, events };
}
/** The text blocks of every session/prompt the peer received, in order. */
export async function prompts(peer: Peer): Promise<readonly (readonly string[])[]> {
  return (await peer.sent()).filter(line => line.method === "session/prompt").map(line => ((line.params?.prompt ?? []) as { type: string; text?: string }[]).filter(block => block.type === "text").map(block => block.text ?? ""));
}
