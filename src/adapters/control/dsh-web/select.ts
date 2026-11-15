import type { CleanupEvidence, CommandClass, ControlEvent, ControlLaunch, ControlOptions, ControlRun, HarnessControl, NativeConversationId, NativeModelCatalog,
  NativeOptions, NativeSessionImport, NativeSessionPage, ProtocolObservation, SteerOutcome, TurnText } from "../../../contracts/control.js";
import type { ContentKind, ContentRef, ControlAttachment } from "../../../contracts/content.js";
import type { RelayCapabilities } from "../../../contracts/relay.js";
import { ControlError } from "../../../infrastructure/control/json-rpc-process.js";
import { dshAcpFlavor } from "../../flavors/dsh.js";
import { DshControl } from "../dsh.js";
import { DshWebControl, dshReading, dshWebRelayCapabilities } from "./control.js";
import { WEB_UNAVAILABLE } from "./host.js";

/**
 * DeepSeek Harness with nothing to choose: its Web host driver (DshWebControl) when the installed dsh has the Web host it was made for and that host
 * starts and answers as it should, otherwise its ACP driver (DshControl, `dsh --profile acp`), as before. The choice is made once per connection, before
 * anything is sent: at initialize by what is installed (version and generated contracts), at the first thing that starts the Web host by how it
 * answers. Falling back is said once, as a diagnostic of the connection's next Turn; the page sees only what each driver can do (its catalog's
 * declaration), never an error. A Web host that failed after it served something is that connection's failure, never a reason to switch.
 */
export class DshDriver implements HarnessControl {
  readonly relayCapabilities: RelayCapabilities = dshWebRelayCapabilities;
  private web: DshWebControl | null;
  private acp: DshControl | null = null;
  private acpReady: Promise<ProtocolObservation> | null = null;
  private note: string | null = null;
  private interactive = false;
  private instructions: { readonly text: string | null; readonly tools?: { readonly progress: boolean } } | null = null;
  constructor(private readonly launch: ControlLaunch, private readonly options: ControlOptions) { this.web = new DshWebControl(launch, options); }

  /** The driver in use, once chosen; the Web host driver until a fallback. */
  private get current(): HarnessControl { return this.web ?? this.acp!; }
  get route(): "web" | "acp" { return this.web !== null ? "web" : "acp"; }
  get sessionTools(): boolean { return this.web?.sessionTools ?? this.acp?.sessionTools ?? false; }
  get steering(): boolean { return this.web !== null ? this.web.steering : this.acp?.steering === true; }
  get unattributedUpdates(): number { return this.current.unattributedUpdates ?? 0; }
  healthy(): boolean { return this.current.healthy?.() ?? false; }
  processGroup(): number | null { return this.current.processGroup?.() ?? null; }
  diagnosticMark(): number { return this.current.diagnosticMark?.() ?? 0; }
  diagnosticsSince(mark: number): string { return this.current.diagnosticsSince?.(mark) ?? ""; }
  enablePermissions(): void { this.interactive = true; this.current.enablePermissions?.(); }
  setSessionInstructions(text: string | null, tools?: { readonly progress: boolean }): void { this.instructions = { text, ...(tools === undefined ? {} : { tools }) }; this.current.setSessionInstructions?.(text, tools); }

  /** Goes on with ACP: the Web host driver is closed (it may have started its process), the ACP driver started with what was said to the other. */
  private async fallBack(reason: string): Promise<ProtocolObservation> {
    const web = this.web;
    this.web = null;
    this.note = "dsh 的 Web 宿主用不了（" + reason + "），这个对话改用它的 ACP 接口：插话、分叉、/compact 这些暂时用不上。";
    if (web !== null) await web.close().catch(() => null);
    this.acp ??= new DshControl(this.launch, this.options);
    if (this.interactive) this.acp.enablePermissions();
    if (this.instructions !== null) this.acp.setSessionInstructions(this.instructions.text, this.instructions.tools);
    this.acpReady ??= this.acp.initialize();
    return this.acpReady;
  }
  /** Runs `use` on the Web host driver; a Web host that did not start or did not answer as expected sends the call to ACP instead. */
  private async either<T>(use: (control: HarnessControl) => Promise<T>): Promise<T> {
    const web = this.web;
    if (web === null) { await this.acpReady; return use(this.acp!); }
    try { return await use(web); }
    catch (error) {
      if (!(error instanceof ControlError) || error.code !== WEB_UNAVAILABLE || web.hostStarted) throw error;
      await this.fallBack(error.message.replace(/^dsh 的 Web 宿主/u, "宿主"));
      return use(this.acp!);
    }
  }
  async initialize(): Promise<ProtocolObservation> {
    if (this.web === null) return this.acpReady ?? this.fallBack("没有可用的 Web 宿主");
    try { return await this.web.initialize(); }
    catch (error) { if (error instanceof ControlError && error.code === WEB_UNAVAILABLE) return this.fallBack(error.message); throw error; }
  }
  open(cwd: string, model?: string, options?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> { return this.either(control => control.open(cwd, model, options, checkpoint)); }
  async checkpoint(): Promise<string | null> { return this.current.checkpoint?.() ?? null; }
  /** The catalog of the driver in use, with the declaration of what it can do (the Web host's own, or the ACP fallback's). */
  async models(): Promise<NativeModelCatalog> {
    return this.either(async control => {
      if (!control.models) throw new ControlError("UNSUPPORTED_MODEL_SELECTION", "this Harness does not expose models");
      const catalog = await control.models();
      // Its ACP runs no command (a prompt that names one reaches the model as text, probed 2026-11-13): nothing it may announce is read as one.
      return control === this.acp ? { ...catalog, commands: [], flavor: dshAcpFlavor } : catalog;
    });
  }
  async nativeConfig(): Promise<{ readonly model: string | null; readonly options: NativeOptions } | null> { return this.current.nativeConfig ? this.current.nativeConfig() : null; }
  classify(text: string, catalog: NativeModelCatalog | null, attachments: readonly ContentKind[] = []): CommandClass {
    return this.current.classify?.(text, catalog, attachments) ?? dshReading(text, null, attachments);
  }
  async checkAttachments(attachments: readonly ContentRef[]): Promise<void> {
    const control = this.current;
    if (!control.checkAttachments) throw new ControlError("ATTACHMENT_UNSUPPORTED", "this Harness interface does not accept attachments");
    await control.checkAttachments(attachments);
  }
  async startText(id: NativeConversationId, turn: TurnText, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    if (this.note !== null) { onEvent({ type: "diagnostic", message: this.note }); this.note = null; }
    return this.current.startText(id, turn, onEvent, attachments);
  }
  async steer(id: NativeConversationId, text: string): Promise<SteerOutcome> {
    const control = this.current;
    if (!control.steer) throw new ControlError("NATIVE_STEER_UNAVAILABLE", "this Harness interface takes no words in the middle of a turn");
    return control.steer(id, text);
  }
  async decidePermission(id: string, option: string, input?: string): Promise<void> {
    const control = this.current;
    if (!control.decidePermission) throw new ControlError("INVALID_STATE", "permission request is not pending");
    await control.decidePermission(id, option, input);
  }
  async setTitle(id: NativeConversationId, title: string): Promise<void> {
    const control = this.current;
    if (!control.setTitle) throw new ControlError("NATIVE_TITLE_UNAVAILABLE", "dsh's ACP gives its sessions no title");
    await control.setTitle(id, title);
  }
  fork(checkpoint: string, cwd: string): Promise<string> {
    return this.either(async control => {
      if (!control.fork) throw new ControlError("NATIVE_FORK_UNAVAILABLE", "dsh's ACP cannot fork a session");
      return control.fork(checkpoint, cwd);
    });
  }
  nativeSessions(cwd: string, cursor?: string): Promise<NativeSessionPage> {
    return this.either(async control => {
      if (!control.nativeSessions) throw new ControlError("NATIVE_SESSION_LIST_UNAVAILABLE", "this Harness cannot list its sessions");
      return control.nativeSessions(cwd, cursor);
    });
  }
  importSession(id: string, cwd: string): Promise<NativeSessionImport> {
    return this.either(async control => {
      if (!control.importSession) throw new ControlError("NATIVE_SESSION_LIST_UNAVAILABLE", "this Harness cannot continue its own sessions in the Hub");
      return control.importSession(id, cwd);
    });
  }
  async close(): Promise<CleanupEvidence> {
    const closes = [this.web?.close(), this.acp?.close()].filter((value): value is Promise<CleanupEvidence> => value !== undefined);
    const settled = await Promise.allSettled(closes);
    const failed = settled.find(result => result.status === "rejected");
    if (failed !== undefined) throw (failed as PromiseRejectedResult).reason;
    return (settled.at(-1) as PromiseFulfilledResult<CleanupEvidence> | undefined)?.value ?? { closed: true, exitCode: null, signal: null, protocolFailure: null };
  }
}
