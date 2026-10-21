import { satisfies } from "semver";
import type { ContentRef } from "../../contracts/content.js";
import type { CleanupEvidence, ControlLaunch, ControlOptions, NativeConversationId, NativeInputs, NativeModelCatalog, NativeOptions } from "../../contracts/control.js";
import { checkInputs } from "../../infrastructure/control/attachments.js";
import { nativeCommand } from "../../infrastructure/control/native-command.js";
import { AcpControl } from "./acp.js";

const COMPACT = { name: "compact", description: "压缩上下文（OpenCode 1.18 的原生 /compact，ACP 目录未列出）" } as const;
/** The versions whose ACP prompt handler is known to compact on an unlisted `/compact`: the 1.18 line, as read in 1.18.35. */
const UNLISTED_COMPACT = ">=1.18.0 <1.19.0";

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
 * The ACP prompt handler of OpenCode 1.18 takes `/compact` that it does not announce. It checks a slash input against its
 * announced commands first, and for `compact` it then calls session.summarize (read in the installed 1.18.35 binary). The
 * Runtime passes only announced commands through unchanged, so for that version line the catalog lists `compact` when
 * OpenCode itself does not, and `/compact` reaches OpenCode as typed. The gate is the reviewed version line, because the
 * branch is undocumented: a later version may drop it or announce it. 1.19 and later get nothing added until their handler
 * is read again. A version that cannot be read, and an agent that already lists `compact`, also get nothing added.
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
  override async models(): Promise<NativeModelCatalog> {
    const native = await super.models(), declared = await this.readInputs(), version = this.agentVersion, listed = native.commands ?? [];
    const catalog = version !== null && satisfies(version, UNLISTED_COMPACT) && !listed.some(command => command.name === COMPACT.name) ? { ...native, commands: [...listed, COMPACT] } : native;
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
