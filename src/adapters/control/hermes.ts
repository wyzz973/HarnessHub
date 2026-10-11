import type { BackendResult, CleanupEvidence, ControlEvent, ControlLaunch, ControlOptions, ControlRun, NativeConversationId, NativeModelCatalog, NativeToolDetail } from "../../contracts/control.js";
import { ControlError, classifyRemoteFailure } from "../../infrastructure/control/json-rpc-process.js";
import { nativeCommand } from "../../infrastructure/control/native-command.js";
import type { ControlAttachment } from "../../contracts/content.js";
import { AcpControl } from "./acp.js";

const EXPORT = { name: "export", description: "导出原生会话记录（Hermes 会话 JSONL）" } as const;
/** One session's export is small and quick; one that is larger or slower fails rather than being cut short (E). */
const EXPORT_BYTES = 8 * 1024 * 1024, EXPORT_DEADLINE_MS = 5000;
/** Without --session-id Hermes exports every session it holds, its messaging gateway's too: the identifier must be a plain one. */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/** Hermes's ACP approval bridge waits this long for the client and then denies the command itself (permissions.py). */
const HERMES_APPROVAL_WAIT_MS = 60_000;
/** Quiet time after Hermes's prompt response before its turn is settled. */
const HERMES_TRAILING_QUIET_MS = 250;
/** Hermes's own terminal failure lines on stderr (run_agent.py and its provider clients), logged when a model call failed for good. */
const TERMINAL_FAILURE = /API call failed after \d+ retries|Non-retryable|BadRequestError|AuthenticationError|PermissionDeniedError|NotFoundError|RateLimitError|Agent error in session/u;
/** server.py logs this when the agent loop raised; the reply is then only `Error: …`. */
const AGENT_ERROR = /Agent error in session/u;
/**
 * acp_adapter/tools.py: `build_tool_complete` reports every finished call as "completed"; a failed one is only told by its
 * text, "<tool> failed: <error>" (`_format_generic_structured_result` and the other formatters), and a refused command's
 * error is "BLOCKED: …" (tools/approval.py).
 */
const TOOL_FAILURE = /^(?:\S[^\n]{0,64} failed: |BLOCKED:)/u;
/** A command Hermes refused: "BLOCKED: User denied…" (tools/approval.py) or "Command denied: …" (tools/terminal_tool.py). */
const REFUSED = /BLOCKED: User denied|Command denied: /u;
/** Hermes answers its own `/model <name>` locally with this text (server.py `_cmd_model`); no ACP update announces it. */
const MODEL_SWITCHED = /^Model switched to: (\S+)[ \t]*\r?\nProvider: (\S+)[ \t]*$/mu;

/**
 * Hermes Agent's ACP server (`hermes acp`, hermes-agent 0.12). Where it departs from ACP v1 the departure is handled
 * here instead of being absorbed by the generic layer:
 * - session/resume of an identity it does not have starts a new session silently, and the response carries no session
 *   identity that would reveal it; recovery therefore uses session/load, whose null result means the session is gone;
 * - session/load replays history after its response; the generic replay window already starts at the response;
 * - resource links and embedded resources never reach its model, so an attached file travels as a text pointer to the
 *   read-only copy, which its own file tools read;
 * - in the reviewed 0.12 bridge an approval left unanswered for 60 s is denied by Hermes, and the public request closes with it;
 *   its "always" option writes to Hermes's own configuration for all of its sessions, which the request says;
 * - its last reply chunks can follow the prompt response, so the turn settles after a short quiet window;
 * - `/model <name>` switches the session's model without an update, so its own reply is the only report of the change;
 * - a failed model call still ends with end_turn and an empty reply (or only `Error: …`); its stderr log is the only report of
 *   the failure, so such a turn is reported as failed with the class its log names, never with the log text itself;
 * - it advertises its agent authentication method only when it resolves a provider with credentials (0.12 leaves the list
 *   out otherwise; later versions add a terminal setup method that says nothing about it), so without that method no
 *   session is opened and the missing setup is reported instead of a prompt that cannot reach a model.
 * Only the `hermes-acp` tool set is active in this mode (no messaging, cron or audio tools).
 */
/**
 * Hermes's ACP bridge, with its 0.12 specifics. ACP has no export method: when Hermes lists no `export` command of its own,
 * the Hub offers `/export`, which runs Hermes's own `hermes sessions export - --session-id <id>` once (never its gateway)
 * and records the session's JSON line as an output of the Run. Nothing is sent to the model.
 */
export class HermesControl extends AcpControl {
  private hubExport = false;
  private readonly exports = new AbortController();
  constructor(private readonly hermesLaunch: ControlLaunch, private readonly hermesOptions: ControlOptions) { super(hermesLaunch, hermesOptions); }
  protected override get restoreByLoad(): boolean { return true; }
  protected override get fileBlocks(): boolean { return false; }
  // The fixed 60-second wait is the reviewed 0.12 bridge; later Hermes makes it configurable, so other versions are not cut short.
  protected override get approvalDeadlineMs(): number | null { return /^0\.12\./u.test(this.agentVersion ?? "") ? HERMES_APPROVAL_WAIT_MS : null; }
  // A call whose text says it failed did fail, whatever status Hermes reported for it.
  protected override toolStatus(status: string, detail: NativeToolDetail | undefined): string { return status === "completed" && TOOL_FAILURE.test(detail?.output ?? "") ? "failed" : status; }
  // In the reviewed 0.12 bridge approval.py calls the approval callback with allow_permanent, which permissions.py's callback
  // does not take; the TypeError is answered with a denial, so no approval ever reaches the client. A refusal in a prompt that
  // asked nothing is that defect, and the reply may claim otherwise.
  protected override toolNotice(detail: NativeToolDetail | undefined, asked: boolean): { readonly title: string; readonly detail: string } | null {
    if (asked || !/^0\.12\./u.test(this.agentVersion ?? "") || !REFUSED.test(detail?.output ?? "")) return null;
    return { title: "Hermes 拒绝了这条命令，但没有请求审批",
      detail: "Hermes 拒绝了这条命令，但没有向 HarnessHub 请求审批（Hermes 0.12.0 的 ACP 审批桥缺陷：approval.py 以 allow_permanent 调用回调，permissions.py 不接受）。HarnessHub 没有修改 Hermes；回复内容可能与实际结果不符。上游 v0.21.6 的这个回调已接受该参数。" };
  }
  // Hermes can send its last reply chunks after the prompt response (Multica waits 250 ms for the same reason).
  protected override get trailingQuietMs(): number { return HERMES_TRAILING_QUIET_MS; }
  // tools/approval.py: "always" adds the dangerous-command pattern to command_allowlist in Hermes's own config.yaml,
  // which every Hermes session reads, its messaging gateway included.
  protected override permissionNote(options: readonly { readonly id: string; readonly kind: string; readonly name: string }[]): string {
    const always = options.find(option => option.kind === "allow_always");
    return always ? `选“${always.name}”会写入 Hermes 自己的配置（command_allowlist），之后 Hermes 的所有会话（包括终端和消息网关）遇到同一类危险命令都不再询问。` : "";
  }
  // acp_adapter/auth.py: the agent method's id is the configured provider, present only when its credentials resolve.
  protected override authentication(methods: readonly { readonly id: string; readonly type: string }[]): NativeModelCatalog["authentication"] { return methods.some(method => method.type === "agent") ? "ready" : "missing"; }
  override async startText(id: NativeConversationId, prompt: string, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    if (this.hubExport && !attachments.length && /^\/export\s*$/u.test(prompt)) {
      return { result: this.exportSession(id, onEvent), requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "an export has no native turn to stop")) };
    }
    // Only Hermes's own command is read for a model switch; a model reply quoting the same words in another turn is never parsed.
    const switching = !attachments.length && /^\/model\s+\S/u.test(prompt.trim()), mark = this.stderrMark;
    let reply = "", answered = false;
    const run = await super.startText(id, prompt, event => { if (event.type === "text") { answered = true; if (reply.length < 4096) reply += event.text; } onEvent(event); }, attachments);
    return { ...run, result: run.result.then((result): BackendResult => {
      const switched = switching ? MODEL_SWITCHED.exec(reply) : null;
      // Hermes lists models as `<provider>:<model>` with the provider lower-cased (server.py `_encode_model_choice`).
      if (result.status === "completed" && switched) this.adoptModel(switched[2]!.toLowerCase() + ":" + switched[1]!);
      // A failed model call still ends with end_turn: nothing is answered (or only Hermes's own "Error: …"), and its log says why.
      if (result.status === "completed" && (!answered || reply.startsWith("Error: "))) {
        const logged = this.stderrSince(mark);
        if (answered ? AGENT_ERROR.test(logged) : TERMINAL_FAILURE.test(logged))
          return { status: "failed", reason: "native_error", error: classifyRemoteFailure(logged) ?? { code: "MODEL_REQUEST_FAILED", message: "Hermes 的模型请求失败了，原因记录在 Hermes 自己的日志里。" } };
      }
      return result;
    }) };
  }
  override async models(): Promise<NativeModelCatalog> {
    const catalog = await super.models();
    this.hubExport = !(catalog.commands ?? []).some(command => command.name === EXPORT.name);
    return this.hubExport ? { ...catalog, commands: [...(catalog.commands ?? []), EXPORT] } : catalog;
  }
  private async exportSession(id: NativeConversationId, onEvent: (event: ControlEvent) => void): Promise<BackendResult> {
    try {
      if (!PLAIN_ID.test(id)) throw new ControlError("NATIVE_EXPORT_UNAVAILABLE", "this Hermes session has no plain identifier");
      const index = this.hermesLaunch.args.lastIndexOf("acp");
      if (index < 0) throw new ControlError("NATIVE_EXPORT_UNAVAILABLE", "this Hermes entry has no command line to export with");
      const output = await nativeCommand(this.hermesLaunch, [...this.hermesLaunch.args.slice(0, index), "sessions", "export", "-", "--session-id", id],
        { ...this.hermesOptions, requestTimeoutMs: EXPORT_DEADLINE_MS, maxFrameBytes: EXPORT_BYTES }, this.exports.signal);
      // An unknown session is answered with a sentence and exit code 0: only one JSON object of this very session counts.
      const line = output.trimEnd();
      let record: unknown = null;
      try { record = JSON.parse(line); } catch { throw new ControlError("NATIVE_EXPORT_UNAVAILABLE", "Hermes has no record of this session"); }
      if (line.includes("\n") || record === null || typeof record !== "object" || Array.isArray(record) || (record as { readonly id?: unknown }).id !== id)
        throw new ControlError("NATIVE_EXPORT_UNAVAILABLE", "Hermes exported something other than this session");
      onEvent({ type: "output", output: { kind: "content", name: "hermes-" + id + ".jsonl", mediaType: "application/x-ndjson", data: Buffer.from(line + "\n", "utf8") } });
      return { status: "completed", reason: "exported" };
    } catch (error) {
      const message = error instanceof ControlError && error.code === "NATIVE_EXPORT_UNAVAILABLE" ? error.message
        : error instanceof ControlError && error.code === "OUTPUT_LIMIT" ? "the Hermes export exceeds 8 MiB"
        : error instanceof ControlError && error.code === "REQUEST_TIMEOUT" ? "the Hermes export took longer than 5 seconds" : "Hermes could not export this session";
      return { status: "failed", reason: "export_failed", error: { code: "NATIVE_EXPORT_UNAVAILABLE", message } };
    }
  }
  override async close(): Promise<CleanupEvidence> { this.exports.abort(); return super.close(); }
}
