import type { ContentKind, ContentRef, ControlAttachment } from "../../contracts/content.js";
import type { BackendResult, CleanupEvidence, CommandClass, ControlEvent, ControlLaunch, ControlOptions, ControlRun, NativeConversationId, NativeInputs, NativeModelCatalog, NativeOptions } from "../../contracts/control.js";
import { checkInputs } from "../../infrastructure/control/attachments.js";
import type { ControlError } from "../../infrastructure/control/json-rpc-process.js";
import type { RelayCapabilities } from "../../contracts/relay.js";
import { nativeCommand } from "../../infrastructure/control/native-command.js";
import { AcpControl } from "./acp.js";
import { OPENCODE_COMPACT as COMPACT, openCodeClassify, openCodeCommand as commandOf, openCodeNativeClassify, relayDeclaration } from "./relay-classify.js";
import { openCodeVendor, slashModelKey } from "./relay-vendor.js";

/**
 * OpenCode's relay declaration (ADR-055 §8.1, OpenCode 2 row): two text blocks; no live evidence and no check (a second
 * connection cannot hold the workspace lease inside finalize), a content prompt that ended proves it recorded, and a
 * cancelled prompt's input may still arrive later (lateDelivery); `/compact` and listed commands, any other slash input
 * text; compaction events; one process per connection; the vendor by the `provider/model` prefix and that provider's
 * `baseURL`; no native title entry (not guaranteed before P13). Not probed.
 */
export const openCodeRelayCapabilities: RelayCapabilities = relayDeclaration({
  probed: false,
  delivery: { live: "none", verify: "none", successProvesRecorded: true, lateDelivery: true },
  execution: "process",
  commands: { unlistedSlash: "text", hidden: [], classify: openCodeClassify },
  placement: { parts: "multiple", maxInput: null, pointersAfterUser: false },
  window: "session_report",
  fixedPrefix: null,
  cacheTtl: "unknown",
  compactionEvidence: "event",
  resolveVendor: openCodeVendor,
  normalizeModel: slashModelKey,
  title: "none",
  hostPathRead: "none",
  sessionTools: null,
});
/** A `/compact` that OpenCode answered with nothing at all: its ACP dropped the command instead of compacting. */
const COMPACT_IGNORED: BackendResult = { status: "failed", reason: "native_error",
  error: { code: "NATIVE_COMMAND_IGNORED", message: "OpenCode 没有执行 /compact：这个版本的 ACP 没有处理这条命令，也没有返回任何内容。" }, input: "not_recorded" };
/** Stop reasons OpenCode gives a prompt only after it delivered the prompt into the session (its turn started). */
const RECORDED_STOPS: ReadonlySet<string> = new Set(["end_turn", "max_tokens", "refusal"]);
/**
 * How OpenCode 2.2.5's ACP refuses a prompt (packages/cli/src/acp, read from the released binary). Its turn reads a step or
 * execution error only once the prompt was delivered into the session, and reports a model failure then as ServiceFailure
 * with `service: "session"` and the error's type as `errorName` (R8 O3), or a provider sign-in failure as auth_required
 * with this message. Before delivery it refuses with invalid params naming the request's `field` (an image without data,
 * an attachment or skill the session refused) or the unknown `sessionId` (R8 O4), with this message while the session
 * already runs an ACP prompt, or with CatalogNotReady while its catalog is loading. Its other refusals (ServerUnavailable,
 * an internal service failure, a prompt identity conflict) can come either way.
 */
const PROVIDER_AUTH = "Authentication required: provider authentication required", BUSY = "Internal error: Session already has an active ACP prompt: ";
const REFUSED_FIELDS: ReadonlySet<string> = new Set(["prompt", "files", "skills"]);

/**
 * Model input kinds from OpenCode 1's `opencode models --verbose`: a `provider/id` line followed by that model's
 * pretty-printed JSON. Only `capabilities.input` is read; anything unparseable leaves the model without declared inputs,
 * and a listing of bare `provider/id` lines (what OpenCode 2's `opencode models` prints; it has no --verbose) declares
 * nothing, so the map stays empty.
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
 * OpenCode ACP declares images for the agent; whether the running model can see them comes from the original CLI catalog
 * where the installed OpenCode has one. OpenCode 1's `opencode models --verbose` prints each model's capabilities;
 * OpenCode 2's `models` has no such flag (packages/cli/src/commands at v2.2.5) and refuses it, so the refinement is tried
 * once per control, quietly: a refusal, a timeout or a listing without capabilities leaves the agent-declared image
 * capability as the only word, and nothing is retried. The line is never read from a version; the command itself answers.
 *
 * OpenCode's ACP prompt handler takes `/compact` without announcing it: from 1.16 to the latest 1.19.x it checks a slash
 * input against its announced commands first, and for `compact` it then calls session.summarize (v1.19.3
 * acp/service.ts:546-583; 1.0–1.15 announced it, and OpenCode 2 announces it as its only built-in command,
 * packages/cli/src/acp/catalog.ts at v2.2.5). The Runtime passes only announced commands through unchanged, so the
 * catalog lists `compact` whenever OpenCode itself does not, whatever version it reports, and never twice: an announced
 * `compact` keeps OpenCode's own entry, and `/compact` reaches OpenCode as typed either way. Whether it ran is judged from
 * the turn itself: 1.18.35 hands the summary back as reply text, OpenCode 2 reports a compaction update, while an ACP that
 * drops a slash input it does not know (1.16–1.19 do, acp/service.ts:585-587) ends the turn with nothing. A `/compact`
 * turn that completes without any reply text, tool or activity therefore fails with NATIVE_COMMAND_IGNORED instead of
 * passing for a compaction.
 *
 * Restoring a conversation goes through the generic `AcpControl`: `session/load` (OpenCode declares loadSession) with the
 * conversation's own cwd, which OpenCode 2 requires to be the session's directory (packages/cli/src/acp at v2.2.5:
 * load, resume and fork refuse another directory); the Hub always opens a session in its conversation's workspace, so
 * nothing here depends on the line.
 *
 * Inputs are read as OpenCode reads them (ADR-055 R0d): trimmed, a listed command, or `/compact`, is a command, with or
 * without attachments; a configured command's template enters the session (keep); any other slash input is text for the
 * model. A content prompt that ended with end_turn, max_tokens or refusal was delivered first (OpenCode starts a turn only
 * on delivery), and so was one that failed with a model failure after delivery; a cancelled one stays unknown, since its
 * input can still be delivered later; one refused before delivery, and an ignored `/compact`, reached nothing (not recorded).
 */
export class OpenCodeControl extends AcpControl {
  override readonly relayCapabilities: RelayCapabilities = openCodeRelayCapabilities;
  private modelInputs: Promise<ReadonlyMap<string, { readonly image: boolean; readonly audio: boolean }> | null> | null = null;
  private openedModel: string | undefined;
  private readonly abort = new AbortController();
  constructor(private readonly nativeLaunch: ControlLaunch, private readonly nativeOptions: ControlOptions) { super(nativeLaunch, nativeOptions); }
  protected override promptRecorded(reason: string): boolean { return RECORDED_STOPS.has(reason); }
  protected override refusedPrompt(error: ControlError): "recorded" | "not_recorded" | null {
    const fields = error.remoteFields;
    if (error.remoteCode === -32603 && fields?.service === "session" && fields.errorName !== undefined || error.remoteCode === -32000 && error.remoteMessage === PROVIDER_AUTH) return "recorded";
    if (error.remoteCode === -32602 && (REFUSED_FIELDS.has(fields?.field ?? "") || fields?.sessionId !== undefined)) return "not_recorded";
    return error.remoteCode === -32603 && (error.remoteMessage?.startsWith(BUSY) === true || fields?.errorName === "CatalogNotReady") ? "not_recorded" : null;
  }
  override classify(text: string, catalog: NativeModelCatalog | null, _attachments: readonly ContentKind[] = []): CommandClass { return openCodeNativeClassify(text, catalog); }
  /**
   * The per-model input kinds of the original CLI catalog, read once per control: null when the command is refused
   * (OpenCode 2 has no `models --verbose`), fails or prints no capabilities. Unavailable metadata only removes the
   * per-model refinement; it never fails a turn or a catalog read, and the attempt is never repeated.
   */
  private readInputs(): Promise<ReadonlyMap<string, { readonly image: boolean; readonly audio: boolean }> | null> {
    const index = this.nativeLaunch.args.lastIndexOf("acp");
    if (index < 0) return Promise.resolve(null);
    this.modelInputs ??= nativeCommand(this.nativeLaunch, [...this.nativeLaunch.args.slice(0, index), "models", "--verbose"], this.nativeOptions, this.abort.signal)
      .then(output => { const declared = parseOpenCodeModels(output); return declared.size === 0 ? null : declared; }, () => null);
    return this.modelInputs;
  }
  override async open(cwd: string, model?: string, options?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    const id = await super.open(cwd, model, options, checkpoint); this.openedModel = model; return id;
  }
  override async startText(id: NativeConversationId, prompt: string, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    // The same reading as classify(): only a bare `/compact` without attachments is judged by what it answered.
    const named = commandOf(prompt);
    if (attachments.length || named?.name !== COMPACT.name || named.args !== "") return super.startText(id, prompt, onEvent, attachments);
    let answered = false;
    const run = await super.startText(id, prompt, event => { if (event.type === "text" || event.type === "tool" || event.type === "activity") answered = true; onEvent(event); });
    return { ...run, result: run.result.then(result => result.status === "completed" && !answered ? COMPACT_IGNORED : result) };
  }
  override async models(): Promise<NativeModelCatalog> {
    const native = await super.models(), declared = await this.readInputs(), listed = (native.commands ?? []).map(command => ({ ...command, contextEffect: command.name === COMPACT.name ? COMPACT.contextEffect : command.contextEffect ?? "keep" }));
    const catalog = { ...native, commands: listed.some(command => command.name === COMPACT.name) ? listed : [...listed, COMPACT] };
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
