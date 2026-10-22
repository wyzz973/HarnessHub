import type { ContentRef, ControlAttachment } from "../../contracts/content.js";
import type { BackendResult, CleanupEvidence, ControlEvent, ControlLaunch, ControlOptions, ControlRun, NativeConversationId, NativeInputs, NativeModelCatalog, NativeOptions } from "../../contracts/control.js";
import { checkInputs } from "../../infrastructure/control/attachments.js";
import { nativeCommand } from "../../infrastructure/control/native-command.js";
import { AcpControl } from "./acp.js";

const COMPACT = { name: "compact", description: "压缩上下文（OpenCode 的 /compact；原程序的 ACP 目录没有列出，由 HarnessHub 补入）" } as const;
/** A `/compact` that OpenCode answered with nothing at all: its ACP dropped the command instead of compacting. */
const COMPACT_IGNORED: BackendResult = { status: "failed", reason: "native_error",
  error: { code: "NATIVE_COMMAND_IGNORED", message: "OpenCode 没有执行 /compact：这个版本的 ACP 没有处理这条命令，也没有返回任何内容。" } };

/**
 * Model input kinds from `opencode models --verbose`: a `provider/id` line followed by that model's pretty-printed JSON.
 * Only `capabilities.input` is read; anything unparseable leaves the model without declared inputs.
 */
export function parseOpenCodeModels(output: string): ReadonlyMap<string, { readonly image: boolean; readonly audio: boolean }> {
  const result = new Map<string, { image: boolean; audio: boolean }>(), lines = output.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const id = lines[index]!.trim();
    if (!/^[^\s/{}]+\/\S+$/u.test(id) || lines[index + 1] !== "{") continue;
    const end = lines.indexOf("}", index + 1);
    if (end < 0) break;
    try {
      const value: unknown = JSON.parse(lines.slice(index + 1, end + 1).join("\n"));
      const input = value !== null && typeof value === "object" ? (value as { capabilities?: { input?: Record<string, unknown> } }).capabilities?.input : undefined;
      if (input !== undefined && input !== null && typeof input === "object") result.set(id, { image: input.image === true, audio: input.audio === true });
    } catch { /* A model block that is not JSON keeps no declared inputs. */ }
    index = end;
    if (result.size >= 4096) break;
  }
  return result;
}

/**
 * OpenCode ACP declares images for the agent; whether the running model can see them comes from the original CLI catalog.
 *
 * OpenCode's ACP prompt handler takes `/compact` without announcing it: from 1.16 to the latest 1.19.3 it checks a slash
 * input against its announced commands first, and for `compact` it then calls session.summarize (v1.19.3
 * acp/service.ts:546-583; 1.0–1.15 announced it, and OpenCode 2 announces it as a built-in). The Runtime passes only
 * announced commands through unchanged, so the catalog lists `compact` whenever OpenCode itself does not, whatever version
 * it reports, and `/compact` reaches OpenCode as typed. Whether it ran is judged from the turn itself: 1.18.35 hands the
 * summary back as reply text, while an ACP that drops a slash input it does not know (1.16–1.19 do, acp/service.ts:585-587)
 * ends the turn with nothing. A `/compact` turn that completes without any reply text, tool or activity therefore fails
 * with NATIVE_COMMAND_IGNORED instead of passing for a compaction.
 */
export class OpenCodeControl extends AcpControl {
  private modelInputs: Promise<ReadonlyMap<string, { readonly image: boolean; readonly audio: boolean }> | null> | null = null;
  private openedModel: string | undefined;
  private readonly abort = new AbortController();
  constructor(private readonly nativeLaunch: ControlLaunch, private readonly nativeOptions: ControlOptions) { super(nativeLaunch, nativeOptions); }
  /** Unavailable metadata only removes the per-model refinement; it never fails a turn or a catalog read. */
  private readInputs(): Promise<ReadonlyMap<string, { readonly image: boolean; readonly audio: boolean }> | null> {
    const index = this.nativeLaunch.args.lastIndexOf("acp");
    if (index < 0) return Promise.resolve(null);
    this.modelInputs ??= nativeCommand(this.nativeLaunch, [...this.nativeLaunch.args.slice(0, index), "models", "--verbose"], this.nativeOptions, this.abort.signal).then(parseOpenCodeModels, () => null);
    return this.modelInputs;
  }
  override async open(cwd: string, model?: string, options?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    const id = await super.open(cwd, model, options, checkpoint); this.openedModel = model; return id;
  }
  override async startText(id: NativeConversationId, prompt: string, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    if (attachments.length || !/^\/compact\s*$/u.test(prompt)) return super.startText(id, prompt, onEvent, attachments);
    let answered = false;
    const run = await super.startText(id, prompt, event => { if (event.type === "text" || event.type === "tool" || event.type === "activity") answered = true; onEvent(event); });
    return { ...run, result: run.result.then(result => result.status === "completed" && !answered ? COMPACT_IGNORED : result) };
  }
  override async models(): Promise<NativeModelCatalog> {
    const native = await super.models(), declared = await this.readInputs(), listed = native.commands ?? [];
    const catalog = listed.some(command => command.name === COMPACT.name) ? native : { ...native, commands: [...listed, COMPACT] };
    if (declared === null) return catalog;
    const agent: NativeInputs = catalog.inputs ?? { image: false, audio: false, file: true };
    return { ...catalog, models: catalog.models.map(row => { const own = declared.get(row.id); return own ? { ...row, inputs: { image: agent.image && own.image, audio: agent.audio && own.audio, file: true } } : row; }) };
  }
  override async checkAttachments(attachments: readonly ContentRef[]): Promise<void> {
    await super.checkAttachments(attachments);
    if (!attachments.some(item => item.kind !== "file")) return;
    const catalog = await this.models(), entry = catalog.models.find(row => row.id === (this.openedModel ?? catalog.defaultModel));
    if (entry?.inputs) checkInputs(attachments, entry.inputs);
  }
  override async close(): Promise<CleanupEvidence> {
    this.abort.abort();
    await this.modelInputs;
    return super.close();
  }
}
