import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import { TOOL_INPUT_BYTES, TOOL_OUTPUT_BYTES, type BackendResult, type ControlEvent, type ControlRun, type ControlLaunch, type ControlOptions, type NativeConversationId, type NativeModelCatalog, type NativeOptions, type NativeToolDetail, type CleanupEvidence } from "../../contracts/control.js";
import { AcpControl } from "./acp.js";
import { classifyRemoteFailure, ControlError, object } from "../../infrastructure/control/json-rpc-process.js";
import { nativeCommand } from "../../infrastructure/control/native-command.js";
import { string } from "../../infrastructure/control/json-rpc-process.js";
import { checkInputs } from "../../infrastructure/control/attachments.js";
import type { ContentRef, ControlAttachment } from "../../contracts/content.js";

function transcriptSeq(value: unknown): number | null {
  const meta = value !== null && typeof value === "object" ? (value as { __openclaw?: { seq?: unknown } }).__openclaw : undefined;
  return typeof meta?.seq === "number" && Number.isSafeInteger(meta.seq) ? meta.seq : null;
}
function blocks(value: unknown): readonly Record<string, unknown>[] {
  const content = value !== null && typeof value === "object" ? (value as { content?: unknown }).content : undefined;
  return Array.isArray(content) ? content.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object") : [];
}
function textOf(value: unknown): string { return blocks(value).flatMap(block => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n"); }
function cap(value: string, limit: number, tail = false): { text: string; cut: boolean } {
  const bytes = Buffer.from(value); if (bytes.length <= limit) return { text: value, cut: false };
  return { text: new TextDecoder().decode(tail ? bytes.subarray(bytes.length - limit) : bytes.subarray(0, limit)), cut: true };
}
const TOOL_KIND: Readonly<Record<string, string>> = { exec: "execute", bash: "execute", process: "execute", read: "read", write: "edit", edit: "edit", apply_patch: "edit", web_search: "search", web_fetch: "fetch", memory_search: "search", sessions_spawn: "subagent" };
/** Maps the turn's own transcript entries (Pi-format agent messages) to public tool, thinking and usage facts and the real outcome. */
function reconcileTurn(entries: readonly unknown[], backend: BackendResult, emit: (event: ControlEvent) => void, withThinking: boolean): BackendResult {
  const results = new Map<string, { output: string; failed: boolean }>();
  for (const entry of entries) {
    const row = entry as Record<string, unknown>;
    if (row.role === "toolResult" && typeof row.toolCallId === "string") results.set(row.toolCallId, { output: textOf(row), failed: row.isError === true });
  }
  const usage = { input: 0, output: 0, cachedInput: 0, cacheWrite: 0, total: 0 }, cost = { amount: 0 };
  let counted = false, last: Record<string, unknown> | undefined;
  for (const entry of entries) {
    const row = entry as Record<string, unknown>;
    if (row.role !== "assistant") continue;
    last = row;
    for (const block of blocks(row)) {
      if (withThinking && block.type === "thinking" && typeof block.thinking === "string" && block.thinking) emit({ type: "thinking", text: block.thinking + "\n" });
      if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
      const done = results.get(block.id), input = cap(JSON.stringify(block.arguments ?? {}, null, 2), TOOL_INPUT_BYTES), output = done ? cap(done.output, TOOL_OUTPUT_BYTES, true) : null;
      const args = block.arguments !== null && typeof block.arguments === "object" ? block.arguments as Record<string, unknown> : {};
      const summary = [args.command, args.path, args.file_path, args.query, args.url].find(value => typeof value === "string") as string | undefined;
      emit({ type: "tool", id: block.id.slice(0, 256), title: (block.name + (summary ? ": " + summary : "")).replace(/[\0-\x1f\x7f]+/gu, " ").trim().slice(0, 4096), status: done ? (done.failed ? "failed" : "completed") : "completed",
        detail: { kind: TOOL_KIND[block.name] ?? "other", name: block.name.slice(0, 256), input: input.text, ...(output?.text ? { output: output.text } : {}), ...(input.cut || output?.cut ? { truncated: true } : {}) } satisfies NativeToolDetail });
    }
    const call = row.usage !== null && typeof row.usage === "object" ? row.usage as Record<string, unknown> : null;
    if (call) {
      counted = true;
      const add = (key: keyof typeof usage, value: unknown) => { if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage[key] += value; };
      add("input", call.input); add("output", call.output); add("cachedInput", call.cacheRead); add("cacheWrite", call.cacheWrite); add("total", call.totalTokens);
      const spent = call.cost !== null && typeof call.cost === "object" ? (call.cost as { total?: unknown }).total : undefined;
      if (typeof spent === "number" && Number.isFinite(spent) && spent > 0) cost.amount += spent;
    }
  }
  if (counted) emit({ type: "usage", usage: { turn: usage, ...(cost.amount > 0 ? { cost: { amount: cost.amount, currency: "USD", scope: "turn" } } : {}) } });
  // The bridge turns a model or provider error into end_turn; the transcript keeps the real stop reason.
  if (backend.status === "completed" && last?.stopReason === "error") {
    const classified = typeof last.errorMessage === "string" ? classifyRemoteFailure(last.errorMessage) : undefined;
    return { status: "failed", reason: "native_error", error: classified ?? { code: "MODEL_REQUEST_FAILED", message: "OpenClaw 的模型请求失败；原生会话记录了这个错误。" } };
  }
  return backend;
}

/** The installed OpenClaw bridge accepts sessionKey in _meta. A normal chat key avoids its ACP-runtime namespace. */
export class OpenClawControl extends AcpControl {
  private configuredModel: string | null = null;
  /** Session-local model applied with sessions.patch; otherwise the agent's configured model runs. */
  private openedModel: string | undefined;
  private sessionKey: string | null = null;
  private restoredKey: string | null = null;
  private readonly abort = new AbortController();
  private readonly commands = new Set<Promise<unknown>>();
  private nativeModels: Promise<NativeModelCatalog["models"]> | null = null;
  constructor(private readonly nativeLaunch: ControlLaunch, private readonly nativeOptions: ControlOptions,
    private readonly nativeRequest?: (method: "models.list" | "sessions.patch" | "sessions.get", params: Readonly<Record<string, unknown>>) => Promise<unknown>) { super(nativeLaunch, nativeOptions); }
  protected override async sessionParameters(cwd: string): Promise<Readonly<Record<string, unknown>>> {
    const env = this.nativeLaunch.env, path = env.OPENCLAW_CONFIG_PATH ?? join(env.OPENCLAW_STATE_DIR ?? join(env.HOME ?? homedir(), ".openclaw"), "openclaw.json");
    let config: Record<string, unknown>;
    try {
      const info = await stat(path); if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new ControlError("NATIVE_CONFIGURATION_INVALID", "native configuration exceeds its budget");
      const source = await readFile(path, "utf8"); if (Buffer.byteLength(source) > 2 * 1024 * 1024) throw new ControlError("NATIVE_CONFIGURATION_INVALID", "native configuration grew beyond its budget");
      const value: unknown = JSON5.parse(source); config = object(value, "OpenClaw configuration");
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") config = {};
      else throw new ControlError("NATIVE_CONFIGURATION_INVALID", "cannot read the native OpenClaw configuration");
    }
    const agents = config.agents === undefined ? {} : object(config.agents, "native agents");
    const list = agents.list === undefined ? [] : agents.list;
    if (!Array.isArray(list) || list.length > 256) throw new ControlError("NATIVE_CONFIGURATION_INVALID", "invalid native agent catalog");
    const entries = list.map(value => object(value, "native agent"));
    const selected = entries.find(entry => entry.default === true) ?? entries[0];
    const agent = selected?.id ?? "main";
    if (typeof agent !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(agent)) throw new ControlError("NATIVE_CONFIGURATION_INVALID", "invalid native default agent");
    const defaults = agents.defaults === undefined ? {} : object(agents.defaults, "native agent defaults");
    const model = selected?.model ?? defaults.model;
    const primary = typeof model === "string" ? model : model == null ? null : object(model, "native model").primary;
    if (primary != null && (typeof primary !== "string" || !primary.trim() || primary.length > 1024 || /[\0\r\n]/u.test(primary))) throw new ControlError("NATIVE_CONFIGURATION_INVALID", "invalid native configured model");
    this.configuredModel = primary ?? null;
    this.sessionKey = this.restoredKey ?? "agent:" + agent.toLowerCase() + ":harnesshub:" + randomUUID();
    return { ...await super.sessionParameters(cwd), _meta: { sessionKey: this.sessionKey, ...(this.restoredKey === null ? {} : { requireExistingSession: true, resetSession: false }) } };
  }
  private call(method: "models.list" | "sessions.patch" | "sessions.get", params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.nativeRequest) return this.nativeRequest(method, params);
    const index = this.nativeLaunch.args.lastIndexOf("acp");
    if (index < 0) return Promise.reject(new ControlError("UNSUPPORTED_CONTROL", "OpenClaw native CLI prefix unavailable"));
    const pending = nativeCommand(this.nativeLaunch, [...this.nativeLaunch.args.slice(0, index), "gateway", "call", method, "--json", "--params", JSON.stringify(params)], this.nativeOptions, this.abort.signal).then(value => { let parsed: unknown; try { parsed=JSON.parse(value); } catch { throw new ControlError("INVALID_NATIVE_METADATA","native CLI returned invalid JSON"); } return parsed; });
    this.commands.add(pending); void pending.finally(() => this.commands.delete(pending)).catch(() => {}); return pending;
  }
  private readNativeModels(): Promise<NativeModelCatalog["models"]> {
    this.nativeModels ??= this.call("models.list", {}).then(value => {
      const data = object(value, "OpenClaw native models");
      if (!Array.isArray(data.models) || data.models.length > 4096) throw new ControlError("INVALID_PROTOCOL", "invalid OpenClaw model catalog");
      const models = data.models.map(value => {
        const row = object(value, "OpenClaw model"), provider = string(row.provider, "model provider", 128), id = string(row.id, "model identity", 768);
        if (row.input !== undefined && (!Array.isArray(row.input) || row.input.length > 16 || row.input.some(item => typeof item !== "string"))) throw new ControlError("INVALID_PROTOCOL", "invalid OpenClaw model input kinds");
        // The bridge forwards only images as attachments (audio is dropped); a model without image input would answer without seeing it.
        return { id: provider + "/" + id, name: string(row.name, "model name", 1024), ...(Array.isArray(row.input) ? { inputs: { image: row.input.includes("image"), audio: false, file: true } } : {}) };
      });
      if (new Set(models.map(row => row.id)).size !== models.length) throw new ControlError("INVALID_PROTOCOL", "duplicate OpenClaw models");
      return models;
    });
    return this.nativeModels;
  }
  /** The installed bridge answers session/fork with Method not found even where it declares session capabilities. */
  override async fork(): Promise<string> { throw new ControlError("NATIVE_FORK_UNAVAILABLE", "the OpenClaw ACP bridge cannot fork sessions"); }
  /** OpenClaw's Gateway drops image attachments above 5,000,000 bytes with only a log line; refuse them up front instead. */
  protected override get maxInlineImageBytes(): number { return 5_000_000; }
  override async checkpoint(): Promise<string | null> {
    const conversation = await super.checkpoint();
    return conversation !== null && this.sessionKey !== null ? JSON.stringify({ conversation, key: this.sessionKey }) : null;
  }
  override async open(cwd: string, model?: string, options?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    let conversation: string | undefined;
    if (checkpoint !== undefined) {
      let parsed: unknown; try { parsed = JSON.parse(checkpoint); } catch { throw new ControlError("INVALID_CHECKPOINT", "invalid native recovery reference"); }
      const value = object(parsed, "OpenClaw recovery reference");
      if (Object.keys(value).some(key => !["conversation", "key"].includes(key)) || typeof value.key !== "string" || !/^agent:[a-z0-9_-]+:harnesshub:[a-f0-9-]+$/u.test(value.key)) throw new ControlError("INVALID_CHECKPOINT", "native key is not a Hub-owned conversation");
      this.restoredKey = value.key; conversation = string(value.conversation, "native conversation");
    }
    const id = await super.open(cwd, undefined, options, conversation);
    if (model !== undefined) {
      if (!(await this.readNativeModels()).some(row => row.id === model)) throw new ControlError("MODEL_UNAVAILABLE", "model unavailable in original OpenClaw catalog");
      if (this.sessionKey === null || !/^agent:[a-z0-9_-]+:harnesshub:[a-f0-9-]+$/u.test(this.sessionKey)) throw new ControlError("IDENTITY_MISMATCH", "OpenClaw session override has no owned key");
      const patched = object(await this.call("sessions.patch", { key: this.sessionKey, model }), "OpenClaw model override");
      const resolved = object(patched.resolved, "OpenClaw resolved model");
      if (resolved.modelProvider + "/" + resolved.model !== model) throw new ControlError("MODEL_MISMATCH", "OpenClaw did not apply the selected session model");
      this.openedModel = model;

    }
    return id;
  }
  /** Agent-level checks first, then the running model's own input kinds from the original catalog when it lists them. */
  override async checkAttachments(attachments: readonly ContentRef[]): Promise<void> {
    await super.checkAttachments(attachments);
    if (!attachments.some(item => item.kind === "image")) return;
    const model = this.openedModel ?? this.configuredModel, entry = (await this.readNativeModels()).find(row => row.id === model);
    if (entry?.inputs) checkInputs(attachments, entry.inputs);
  }
  /** Highest transcript sequence of the Hub-owned session; null when it cannot be read (the turn then stays as the bridge reported it). */
  private async transcriptSeq(): Promise<number | null> {
    if (this.sessionKey === null) return null;
    try {
      const messages = object(await this.call("sessions.get", { key: this.sessionKey, limit: 1 }), "OpenClaw transcript").messages;
      if (!Array.isArray(messages)) return null;
      return messages.reduce((max: number, value) => Math.max(max, transcriptSeq(value) ?? 0), 0);
    } catch { return null; }
  }
  /**
   * The ACP bridge forwards only reply text and reports Gateway errors as end_turn. After the turn, this session's own
   * transcript (read through the original CLI) supplies the tool calls and results, reasoning, per-call usage and the
   * real stop reason of exactly the messages this turn appended.
   */
  override async startText(id: NativeConversationId, prompt: string, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    const before = await this.transcriptSeq();
    let thought = false;
    const run = await super.startText(id, prompt, event => { if (event.type === "thinking") thought = true; onEvent(event); }, attachments);
    const result = run.result.then(async backend => {
      if (before === null || this.sessionKey === null || backend.status === "cancelled") return backend;
      let messages: unknown;
      try { messages = object(await this.call("sessions.get", { key: this.sessionKey, limit: 200 }), "OpenClaw transcript").messages; }
      catch { onEvent({ type: "diagnostic", message: "OpenClaw transcript was not readable after the turn" }); return backend; }
      if (!Array.isArray(messages)) return backend;
      return reconcileTurn(messages.filter(value => (transcriptSeq(value) ?? 0) > before), backend, onEvent, !thought);
    });
    return { result, requestStop: run.requestStop };
  }
  override async models(): Promise<NativeModelCatalog> {
    const catalog = await super.models();
    const models = await this.readNativeModels();
    return { ...catalog, defaultModel: this.configuredModel, models, canSelect: models.length > 0 };
  }
  override async close(): Promise<CleanupEvidence> { this.abort.abort(); const commands = [...this.commands]; const results = await Promise.allSettled(commands); const cleanup = await super.close(); const failed = results.find(result => result.status === "rejected" && result.reason instanceof ControlError && result.reason.code === "CLEANUP_FAILED"); if (failed?.status === "rejected") throw failed.reason; return cleanup; }
}
