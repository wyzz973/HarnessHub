import type { ControlEvent, ControlRun, NativeConversationId } from "../../contracts/control.js";
import type { ControlAttachment } from "../../contracts/content.js";
import { AcpControl } from "./acp.js";

/** Hermes's ACP approval bridge waits this long for the client and then denies the command itself (permissions.py). */
const HERMES_APPROVAL_WAIT_MS = 60_000;
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
 * - an approval left unanswered for 60 s is denied by Hermes, and the public request closes with it;
 * - `/model <name>` switches the session's model without an update, so its own reply is the only report of the change.
 * Only the `hermes-acp` tool set is active in this mode (no messaging, cron or audio tools).
 */
export class HermesControl extends AcpControl {
  protected override get restoreByLoad(): boolean { return true; }
  protected override get fileBlocks(): boolean { return false; }
  protected override get approvalDeadlineMs(): number | null { return HERMES_APPROVAL_WAIT_MS; }
  override async startText(id: NativeConversationId, prompt: string, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    // Only Hermes's own command is read this way; a model reply quoting the same words in another turn is never parsed.
    if (attachments.length || !/^\/model\s+\S/u.test(prompt.trim())) return super.startText(id, prompt, onEvent, attachments);
    let reply = "";
    const run = await super.startText(id, prompt, event => { if (event.type === "text" && reply.length < 4096) reply += event.text; onEvent(event); }, attachments);
    return { ...run, result: run.result.then(result => {
      const switched = MODEL_SWITCHED.exec(reply);
      // Hermes lists models as `<provider>:<model>` with the provider lower-cased (server.py `_encode_model_choice`).
      if (result.status === "completed" && switched) this.adoptModel(switched[2]!.toLowerCase() + ":" + switched[1]!);
      return result;
    }) };
  }
}
