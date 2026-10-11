import type { BackendResult, ControlEvent, ControlRun, NativeConversationId } from "../../contracts/control.js";
import { classifyRemoteFailure } from "../../infrastructure/control/json-rpc-process.js";
import type { ControlAttachment } from "../../contracts/content.js";
import { AcpControl } from "./acp.js";

/** Hermes's ACP approval bridge waits this long for the client and then denies the command itself (permissions.py). */
const HERMES_APPROVAL_WAIT_MS = 60_000;
/** Quiet time after Hermes's prompt response before its turn is settled. */
const HERMES_TRAILING_QUIET_MS = 250;
/** Hermes's own terminal failure lines on stderr (run_agent.py and its provider clients), logged when a model call failed for good. */
const TERMINAL_FAILURE = /API call failed after \d+ retries|Non-retryable|BadRequestError|AuthenticationError|PermissionDeniedError|NotFoundError|RateLimitError|Agent error in session/u;
/** server.py logs this when the agent loop raised; the reply is then only `Error: …`. */
const AGENT_ERROR = /Agent error in session/u;
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
 * - its last reply chunks can follow the prompt response, so the turn settles after a short quiet window;
 * - `/model <name>` switches the session's model without an update, so its own reply is the only report of the change;
 * - a failed model call still ends with end_turn and an empty reply (or only `Error: …`); its stderr log is the only report of
 *   the failure, so such a turn is reported as failed with the class its log names, never with the log text itself.
 * Only the `hermes-acp` tool set is active in this mode (no messaging, cron or audio tools).
 */
export class HermesControl extends AcpControl {
  protected override get restoreByLoad(): boolean { return true; }
  protected override get fileBlocks(): boolean { return false; }
  // The fixed 60-second wait is the reviewed 0.12 bridge; later Hermes makes it configurable, so other versions are not cut short.
  protected override get approvalDeadlineMs(): number | null { return /^0\.12\./u.test(this.agentVersion ?? "") ? HERMES_APPROVAL_WAIT_MS : null; }
  // Hermes can send its last reply chunks after the prompt response (Multica waits 250 ms for the same reason).
  protected override get trailingQuietMs(): number { return HERMES_TRAILING_QUIET_MS; }
  override async startText(id: NativeConversationId, prompt: string, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
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
}
