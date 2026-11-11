import type { ProviderTextRedactor } from "../../contracts/provider.js";
import type { CleanupEvidence, ControlEvent, ControlRun, HarnessControl, NativeConversationId, NativeOptions, NativeToolDetail, ProtocolObservation, TurnText } from "../../contracts/control.js";
import type { RelayCapabilities } from "../../contracts/relay.js";
import { SessionError } from "../../contracts/session.js";
import type { ContentRef, ControlAttachment } from "../../contracts/content.js";

function sanitize(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item, redact));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), sanitize(item, redact)]));
  return value;
}
function publicEvent(event: ControlEvent, redact: (text: string) => string): ControlEvent {
  switch (event.type) {
    case "text": case "thinking": return { ...event, text: redact(event.text) };
    case "permission_requested": return { ...event, title: redact(event.title), ...(event.detail === undefined ? {} : { detail: redact(event.detail) }), options: event.options.map(option => ({ id: option.id, name: redact(option.name) })) };
    case "diagnostic": return { ...event, message: redact(event.message) };
    case "tool": return { ...event, id: redact(event.id), title: redact(event.title), status: redact(event.status), ...(event.detail === undefined ? {} : { detail: sanitize(event.detail, redact) as NativeToolDetail }) };
    case "permission": return { ...event, id: redact(event.id) };
    case "plan": return { type: "plan", entries: event.entries.map(entry => ({ ...entry, content: redact(entry.content) })), ...(event.explanation === undefined ? {} : { explanation: redact(event.explanation) }) };
    case "usage": case "input_recorded": return event;
    case "notice": return { ...event, title: redact(event.title), ...(event.detail === undefined ? {} : { detail: redact(event.detail) }) };
    case "activity": return { ...event, id: redact(event.id), title: redact(event.title), ...(event.detail === undefined ? {} : { detail: redact(event.detail) }) };
    case "output": {
      const output = event.output;
      if (output.kind === "link") return { type: "output", output: { ...output, uri: redact(output.uri), name: redact(output.name), ...(output.title === undefined ? {} : { title: redact(output.title) }) } };
      // Text-like native output is redacted like any message; opaque bytes cannot carry an injected secret as text.
      const text = /^text\/|json|xml|yaml|javascript/u.test(output.mediaType) ? new TextDecoder("utf-8", { fatal: false }).decode(output.data) : null;
      return { type: "output", output: { ...output, name: redact(output.name), data: text === null ? output.data : new TextEncoder().encode(redact(text)) } };
    }
  }
}
/** Prevents private injected credentials from entering committed public output or control diagnostics. */
export class RedactedHarnessControl implements HarnessControl {
  /** The relay's optional members pass through as the inner Driver has them (absent stays absent, ADR-055 §3.2). */
  readonly userTextOf?: (replayed: string) => ReturnType<NonNullable<HarnessControl["userTextOf"]>>;
  readonly setTitle?: (id: NativeConversationId, title: string) => Promise<void>;
  /** The inner Driver's static relay declaration, the same object (ADR-055 §3.2). */
  readonly relayCapabilities?: RelayCapabilities;
  constructor(private readonly inner: HarnessControl, private readonly redact: (text: string) => string, private readonly stream: () => ProviderTextRedactor) {
    // A title carries no secret the Driver was given; failures are withheld as any other.
    if (inner.relayCapabilities !== undefined) this.relayCapabilities = inner.relayCapabilities;
    if (inner.userTextOf) this.userTextOf = replayed => inner.userTextOf!(replayed);
    if (inner.setTitle) this.setTitle = (id, title) => this.safe(() => inner.setTitle!(id, title));
  }

  async initialize(): Promise<ProtocolObservation> {
    const value = await this.safe(() => this.inner.initialize());
    const capabilities = sanitize(value.capabilities, this.redact);
    // sanitize preserves the plain object shape; the Driver has already validated its protocol boundary.
    return { ...value, agentName: value.agentName === null ? null : this.redact(value.agentName),
      agentVersion: value.agentVersion === null ? null : this.redact(value.agentVersion),
      authenticationMethods: value.authenticationMethods.map(item => this.redact(item)), capabilities: capabilities as Readonly<Record<string, unknown>> };
  }
  open(cwd: string, model?: string, options?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> { return this.safe(() => this.inner.open(cwd, model, options, checkpoint)); }
  checkpoint(): Promise<string | null> { return this.safe(async () => this.inner.checkpoint ? this.inner.checkpoint() : null); }
  enablePermissions(): void { this.inner.enablePermissions?.(); }
  diagnosticMark(): number { return this.inner.diagnosticMark?.() ?? 0; }
  diagnosticsSince(mark: number): string { return this.redact(this.inner.diagnosticsSince?.(mark) ?? ""); }
  decidePermission(id: string, option: string, input?: string): Promise<void> {
    if (!this.inner.decidePermission) return Promise.reject(new SessionError("UNSUPPORTED_PERMISSION", "native permission decisions unavailable"));
    return this.safe(() => this.inner.decidePermission!(id, option, input));
  }
  fork(checkpoint: string, cwd: string): Promise<string> {
    if (!this.inner.fork) return Promise.reject(new SessionError("NATIVE_FORK_UNAVAILABLE", "this Harness interface cannot branch its native session"));
    return this.safe(() => this.inner.fork!(checkpoint, cwd));
  }
  /** Attachment refusals are Driver-authored and name only the attachment; they pass through redacted. */
  async checkAttachments(attachments: readonly ContentRef[]): Promise<void> {
    if (!this.inner.checkAttachments) throw new SessionError("ATTACHMENT_UNSUPPORTED", "this Harness interface does not accept attachments");
    try { await this.inner.checkAttachments(attachments); }
    catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      if ((code === "ATTACHMENT_UNSUPPORTED" || code === "ATTACHMENT_LIMIT") && error instanceof Error) throw new SessionError(code, this.redact(error.message).slice(0, 512));
      return this.safe(() => Promise.reject(error));
    }
  }
  async startText(id: NativeConversationId, text: TurnText, onEvent: (event: ControlEvent) => void, attachments?: readonly ControlAttachment[]): Promise<ControlRun> {
    const redactor = this.stream();
    const run = await this.safe(() => this.inner.startText(id, text, value => {
      if (value.type !== "text") onEvent(publicEvent(value, this.redact));
      else { const safe = redactor.push(value.text); if (safe) onEvent({ type: "text", text: safe }); }
    }, ...(attachments?.length ? [attachments] : [])));
    return { result: this.safe(() => run.result).then(value => {
      const tail = redactor.flush(); if (tail) onEvent({ type: "text", text: tail });
      return { ...value, reason: this.redact(value.reason), ...(value.error === undefined ? {} : { error: { code: this.redact(value.error.code), message: this.redact(value.error.message) } }) };
    }),
      requestStop: () => this.safe(() => run.requestStop()) };
  }
  async close(): Promise<CleanupEvidence> {
    const value = await this.safe(() => this.inner.close());
    return { ...value, protocolFailure: value.protocolFailure === null ? null : {
      code: this.redact(value.protocolFailure.code), message: this.redact(value.protocolFailure.message) } };
  }
  private async safe<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? this.redact(error.code).slice(0, 128) : "CONTROL_FAILED";
      throw new SessionError(code, "Harness control operation failed; private diagnostics are withheld");
    }
  }
}
