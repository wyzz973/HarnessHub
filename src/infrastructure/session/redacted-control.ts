import type { ProviderTextRedactor } from "../../contracts/provider.js";
import type { CleanupEvidence, ControlEvent, ControlRun, HarnessControl, NativeConversationId, NativeOptions, ProtocolObservation } from "../../contracts/control.js";
import { SessionError } from "../../contracts/session.js";

function sanitize(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item, redact));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), sanitize(item, redact)]));
  return value;
}
function publicEvent(event: ControlEvent, redact: (text: string) => string): ControlEvent {
  switch (event.type) {
    case "text": case "thinking": return { ...event, text: redact(event.text) };
    case "permission_requested": return { ...event, title: redact(event.title), options: event.options.map(option => ({ id: option.id, name: redact(option.name) })) };
    case "diagnostic": return { ...event, message: redact(event.message) };
    case "tool": return { ...event, id: redact(event.id), title: redact(event.title), status: redact(event.status) };
    case "permission": return { ...event, id: redact(event.id) };
  }
}
/** Prevents private injected credentials from entering committed public output or control diagnostics. */
export class RedactedHarnessControl implements HarnessControl {
  constructor(private readonly inner: HarnessControl, private readonly redact: (text: string) => string, private readonly stream: () => ProviderTextRedactor) {}
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
  decidePermission(id: string, option: string, input?: string): Promise<void> {
    if (!this.inner.decidePermission) return Promise.reject(new SessionError("UNSUPPORTED_PERMISSION", "native permission decisions unavailable"));
    return this.safe(() => this.inner.decidePermission!(id, option, input));
  }
  async startText(id: NativeConversationId, text: string, onEvent: (event: ControlEvent) => void): Promise<ControlRun> {
    const redactor = this.stream();
    const run = await this.safe(() => this.inner.startText(id, text, value => {
      if (value.type !== "text") onEvent(publicEvent(value, this.redact));
      else { const safe = redactor.push(value.text); if (safe) onEvent({ type: "text", text: safe }); }
    }));
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
