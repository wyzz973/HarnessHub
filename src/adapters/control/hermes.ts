import type { BackendResult, CleanupEvidence, CommandClass, ControlEvent, ControlLaunch, ControlOptions, ControlRun, NativeConversationId, NativeModelCatalog, NativeOptions, NativeToolDetail, VerifyRequest } from "../../contracts/control.js";
import type { DeliveryPosition, MarkerResult, RelayCapabilities, RelayPacketId, VerifyResult } from "../../contracts/relay.js";
import { ControlError, classifyRemoteFailure } from "../../infrastructure/control/json-rpc-process.js";
import { nativeCommand } from "../../infrastructure/control/native-command.js";
import type { ContentKind, ControlAttachment } from "../../contracts/content.js";
import { AcpControl } from "./acp.js";
import { gatewayRefusalMessage, hermesGatewayPreflight, type HermesGatewayPreflight } from "./hermes-gateway.js";
import { HERMES_COMMAND_WORD as COMMAND_WORD, HERMES_EFFECTS as EFFECTS, HERMES_HIDDEN as HIDDEN, HERMES_LEADING_SPACE as LEADING_SPACE, HERMES_REGISTRY as REGISTRY,
  hermesClassify, hermesCommand as commandOf, hermesNativeClassify, hermesReadsSlash as readsSlash, relayDeclaration, relayEntries } from "./relay-classify.js";
import { hermesModelKey, hermesVendor } from "./relay-vendor.js";
import { type TurnText } from "../../contracts/control.js";
import { carriesWholePacket, cursorDigest, packetEntry, placeTurn, strip, TITLE_DEADLINE_MS, titledPacket, unavailable, verifyResult, type RelayTurn, type UserText } from "./relay-turn.js";

/**
 * Hermes's relay declaration (ADR-055 §8.1, Hermes Agent row): two text blocks with attachment pointers after the user's
 * words; no live evidence, a check on the next open (every open replays the session), and a content prompt that ended
 * proves it recorded; commands as the viewer reads them (lstrip, the registry's names and aliases), `/new` and `/clear`
 * run although unannounced; compaction told by markers in the replay; the gateway runs the session (a viewer that exits is
 * no quiescence); the vendor only by an endpoint it resolves; a native title by `/title` before the first relayed turn.
 * Not probed.
 */
export const hermesRelayCapabilities: RelayCapabilities = relayDeclaration({
  probed: false,
  delivery: { live: "none", verify: "on_next_open", successProvesRecorded: true, lateDelivery: false },
  execution: "gateway",
  commands: { unlistedSlash: "executed", hidden: relayEntries(HIDDEN), classify: hermesClassify },
  placement: { parts: "multiple", maxInput: null, pointersAfterUser: true },
  window: "session_report",
  fixedPrefix: null,
  cacheTtl: "unknown",
  compactionEvidence: "replay_marker",
  resolveVendor: hermesVendor,
  normalizeModel: hermesModelKey,
  title: "set",
  hostPathRead: "none",
  sessionTools: null,
});
const EXPORT = { name: "export", description: "导出原生会话记录（Hermes 会话 JSONL）", contextEffect: "none" } as const;
/**
 * The viewer's answer to a `/compress` that removed nothing (gateway_commands.py `_UNCHANGED['noop']`): the headline of the
 * owner's report (agent/manual_compression_feedback.py), or its fixed fallback.
 */
const COMPRESS_NOOP = /^(?:No changes from compression[.:]|Compression refused \(summary would grow the conversation\):|Compression aborted:)/u;
/** One session's export is small and quick; one that is larger or slower fails rather than being cut short (E). */
const EXPORT_BYTES = 8 * 1024 * 1024, EXPORT_DEADLINE_MS = 5000;
/** The viewer's whole reply to a `/new`, `/clear` or `/reset` that reset the session (gateway_commands.py `_mutate`, v0.22.5). */
const CLEARED = "Conversation history cleared.";
/** The viewer's reply to `/title <name>`, answered locally without a gateway turn (gateway_commands.py `_title` → `_rename`). */
const TITLE_SET = /^Session title set: /u;
/**
 * How a compaction summary reads in a replayed entry (agent/context_compressor.py SUMMARY_PREFIX, LEGACY_SUMMARY_PREFIX and the
 * merged form), besides the `_meta.hermes` flags the viewer adds (acp_adapter/server.py:83-98).
 */
const SUMMARY = /^(?:\[CONTEXT COMPACTION — REFERENCE ONLY\]|\[CONTEXT SUMMARY\]:|\[PRIOR CONTEXT — for reference only; not a new message\])/u;
/** User rows Hermes writes itself, which replay as user entries too (agent/prompt_builder.py, gateway/response_filters.py). */
const INJECTED = /^(?:\[OUT-OF-BAND USER MESSAGE\b|\[System:|\[STILL IN PROGRESS\b)/u;
/** The steer wrapper around a user's words (agent/prompt_builder.py:565-595). */
const STEER = /^(\[OUT-OF-BAND USER MESSAGE[^\n]*\]\n)([\s\S]*?)(\n\[\/OUT-OF-BAND USER MESSAGE\])$/u;
/** What a check keeps of a replay: each user entry's head (a compaction summary's, for the cursor), for the latest entries only. */
const REPLAY_HEAD = 4096, REPLAY_ENTRIES = 1024;
/** Without --session-id Hermes exports every session it holds, its messaging gateway's too: the identifier must be a plain one. */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/** Hermes 0.12's ACP approval bridge waits this long for the client and then denies the command itself (permissions.py). */
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
/** Hermes answers its own `/model <name>` locally with this text (server.py `_cmd_model`); no ACP update announces it. */
const MODEL_SWITCHED = /^Model switched to: (\S+)[ \t]*\r?\nProvider: (\S+)[ \t]*$/mu;
/**
 * The causes Hermes's gateway viewer gives in its JSON-RPC error data (ACP SDK: -32603 "Internal error" with the cause in
 * data.details; acp_adapter/gateway_server.py and hermes_cli/gateway_client.py in v0.22.4). Only these fixed words, and a
 * gateway state's own reason when it is a plain snake_case word, are quoted to the user: the rest of the detail is
 * Hermes's private text.
 */
const NOT_FOUND = /^not_found\b/u;
const GATEWAY_UNAVAILABLE = /^Gateway (starting|incompatible|inaccessible|draining|could not start)(?::\s*([a-z]+(?:_[a-z]+)*)(?=$|[\s(),.;:]))?/u;
/** A turn whose outcome the gateway lost: it may have run, must not be sent again, and blocks the session until discarded. */
const UNKNOWN_OUTCOME = /^(?:unknown_execution\b|Gateway disconnected; turn outcome is unknown)/u;
/** The same refusal of a later prompt while that turn is pending: Hermes submitted nothing (`_unknown_recovery(submitted=False)`). */
const NOT_SUBMITTED = /^unknown_execution\b.*?\(nothing was submitted\)/u;
/** A prompt refused before admission (R8 H4): an unknown session, or the owner's refusal of the submit by its reason code. */
const NOT_ADMITTED = /^(?:not_found|invalid_params|permission_denied)$/u;
const DISCARD = /\/discard ([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?![A-Za-z0-9_-])/u;
/** What each of Hermes's own approval options changes beyond this request, by option id (acp_adapter/permissions.py). */
const OPTION_NOTES: Readonly<Record<string, (name: string) => string>> = {
  allow_always: name => `选“${name}”会写入 Hermes 自己的配置（command_allowlist），之后 Hermes 的所有会话（包括终端和消息网关）遇到同一类危险命令都不再询问。`,
  allow_session: name => `选“${name}”只在这个 HarnessHub 会话内放行，不写 Hermes 的配置。`,
  deny_always: name => `选“${name}”等同于拒绝一次，Hermes 不保存任何东西。`,
};

/**
 * Hermes Agent's ACP server (`hermes acp`). The baseline is its latest release (ADR-053): from v0.22.3 the command is a viewer
 * of the user's Hermes gateway, which runs the sessions, their tools and approvals; 0.12 ran them in the ACP process itself,
 * and is kept as history where it still behaves differently. Before the viewer is started, the gateway preflight of
 * ADR-051 A2 (hermes-gateway.ts) judges the user's gateway from read-only facts: only a compatible running gateway (A) is
 * attached to; when the viewer would stop, replace, wait for or start one (B–E) the connection refuses with
 * NATIVE_GATEWAY_UNAVAILABLE and Hermes's own commands, and no process exists. Where Hermes departs from ACP v1 the
 * departure is handled here instead of being absorbed by the generic layer:
 * - recovery uses session/load: 0.12's session/resume of an identity it does not have started a new session silently and
 *   said nothing; session/load of an unknown identity is a missing session, which 0.12 answered with null and the gateway
 *   viewer refuses with not_found in its error data;
 * - it explains refusals only in its JSON-RPC error data: a gateway that is starting, incompatible, inaccessible, draining
 *   or could not start fails as NATIVE_GATEWAY_UNAVAILABLE with Hermes's own words for it; a prompt whose outcome the
 *   gateway lost records Hermes's /discard instruction, and so does each later prompt Hermes refuses unsent until that
 *   turn is discarded (their Runs still fail as refused requests until the Runtime can record an unknown outcome);
 * - session/load replays history (0.12 after its response, the gateway viewer before it); the generic replay window opens
 *   with the request and lasts until the replay has been quiet;
 * - resource links and embedded resources never reached 0.12's model, so an attached file travels as a text pointer to the
 *   read-only copy, which its own file tools read;
 * - each approval request says what Hermes's own options change beyond it, by option id: allow_always writes
 *   command_allowlist, which every Hermes session reads, its messaging gateway's included; allow_session lasts for this
 *   session; deny_always stores nothing. 0.12's bridge also denied an approval left unanswered for 60 s, which the request
 *   announces (ADR-053's registered exception; later versions make the wait configurable and do not report it);
 * - every finished tool call is reported as completed, and a failed one says so only in its text, so such a call is failed;
 * - its last reply chunks can follow the prompt response, so the turn settles after a short quiet window;
 * - `/model <name>` switches the session's model without an update, so its own reply is the only report of the change;
 * - in 0.12 a failed model call still ended with end_turn and an empty reply (or only `Error: …`), its stderr log being the
 *   only report of the failure, so such a turn is reported as failed with the class its log names, never with the log text
 *   itself (the gateway logs elsewhere, where this reads nothing);
 * - it advertises its agent authentication method only when it resolves a provider with credentials (0.12 leaves the list
 *   out otherwise; later versions add a terminal setup method that says nothing about it), so without that method no
 *   session is opened and the missing setup is reported instead of a prompt that cannot reach a model.
 * ACP has no export method: when Hermes lists no `export` command of its own, the Hub offers `/export`, which runs Hermes's
 * own `hermes sessions export - --session-id <id>` once (never its gateway) and records the session's JSON line as an output
 * of the Run. Nothing is sent to the model.
 *
 * Inputs are read as the viewer reads them (ADR-055 R0d): stripped and split as Python does, a slash word the registry
 * resolves (any case, aliases included) or this Hermes announced is a command, with the effect EFFECTS names for its
 * arguments; a path, any other slash word and every input with an image are prompt text (an attached file goes as text, so
 * it changes nothing). A `/compress` the viewer answers with its no-change report ran and changed nothing (noop). A
 * content prompt that ended with end_turn was admitted and written to the session before the model was called, unless it
 * is a slash word that only reads like a command name (a later Hermes may run it); a prompt refused before admission (an
 * unavailable gateway, an unknown session, a refused submit, a lost turn still pending) never reached it (not recorded);
 * one whose outcome the gateway lost may have run (unknown, and never sent again here).
 */
/** What the latest open's replay showed, as far as a check and a position read it. */
interface ReplayHistory {
  /**
   * User entries by their place in the replay (one per user row), the latest REPLAY_ENTRIES only: the packet each one's title
   * line names and whether it holds that packet whole (title and end lines, read from its whole text as it replays, F10).
   */
  readonly users: { readonly index: number; readonly titled: RelayPacketId | null; readonly whole: boolean; readonly summary: boolean; readonly injected: boolean }[];
  /** User entries replayed in all, and entries of any other kind (agent messages, thoughts, tool calls). */
  total: number;
  others: number;
  /** The compaction summaries seen (their heads and lengths), the cursor's digest. */
  readonly summaries: string[];
}
const emptyHistory = (): ReplayHistory => ({ users: [], total: 0, others: 0, summaries: [] });
export class HermesControl extends AcpControl {
  override readonly relayCapabilities: RelayCapabilities = hermesRelayCapabilities;
  private hubExport = false;
  private readonly exports = new AbortController();
  private history: ReplayHistory = emptyHistory();
  protected override get vendorHarness(): "hermes" { return "hermes"; }
  override async open(cwd: string, model?: string, options?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    this.history = emptyHistory(); this.prompted = false;
    return super.open(cwd, model, options, checkpoint);
  }
  /**
   * The viewer replays the whole live history at each open, before its load response (gateway_server.py:340-387): one user
   * entry per user row, then agent thoughts, messages and tool calls (server.py:126-168); compaction summaries carry
   * `_meta.hermes.compactionSummary` or `containsCompactionSummary`, or read as one.
   */
  protected override replayed(kind: string, update: Readonly<Record<string, unknown>>): void {
    if (!["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(kind)) return;
    const content = update.content !== null && typeof update.content === "object" ? update.content as Record<string, unknown> : {};
    const text = content.type === "text" && typeof content.text === "string" ? content.text : "";
    const meta = [update._meta, content._meta].map(value => value !== null && typeof value === "object" ? (value as Record<string, unknown>).hermes : undefined)
      .find(value => value !== null && typeof value === "object") as Record<string, unknown> | undefined;
    const summary = kind.endsWith("message_chunk") && (meta?.compactionSummary === true || meta?.containsCompactionSummary === true || SUMMARY.test(text));
    if (summary && this.history.summaries.length < 64) this.history.summaries.push(text.slice(0, REPLAY_HEAD) + "\0" + text.length);
    if (kind !== "user_message_chunk") { this.history.others++; return; }
    const titled = titledPacket(text);
    this.history.users.push({ index: this.history.total++, titled, whole: titled !== null && carriesWholePacket(text, titled), summary, injected: INJECTED.test(text) });
    if (this.history.users.length > REPLAY_ENTRIES) this.history.users.shift();
  }
  /** Whether this open read the whole history: a new session (none yet) or one the viewer replayed (session/load). */
  private get historyRead(): boolean { const opened = this.opened; return opened !== null && opened.method !== "resume"; }
  /**
   * Whether this connection sent a prompt since its open: the replay read at open then no longer holds the history (it lacks
   * what the prompt wrote, a clear or an undo among them), so neither a position nor a check reads it any more (F7).
   */
  private prompted = false;
  /**
   * Where the history stands before a Turn's input (ADR-055 §8.1, F20): the number of user entries this open replayed; none
   * once this connection sent a prompt (its replay no longer holds the history).
   */
  async deliveryPosition(id: NativeConversationId): Promise<DeliveryPosition> {
    this.assertOwned(id);
    return this.historyRead && !this.prompted ? { kind: "seq", before: this.history.total } : { kind: "none" };
  }
  /**
   * Looks for each packet in the user entries this open replayed after the packet's position, rows Hermes writes itself left
   * out (VF1-08): the first of them with its title line, a later one only whole (packetEntry, F10, worked out as the replay
   * was read); present when one carries it. A compaction summary that holds it is compacted (a packet folded into a merged
   * summary is no entry of its own). A replay that holds a compaction summary has shifted positions (compacted rows are no
   * longer replayed), so the whole replay is searched then, whole packets only, since which entry came first after the position
   * cannot be told. Not found: outside_window when the entries after the position are older than what a check keeps, absent
   * otherwise (the viewer replays the whole live history), the cursor (the summaries seen) telling the coordinator that a
   * compaction may explain it. unavailable when the history was not replayed or this connection prompted since its open
   * (F7). historyEmpty: the replay held nothing at all. Reads only what open read.
   */
  async verifyDelivered(id: NativeConversationId, request: VerifyRequest): Promise<VerifyResult> {
    const started = Date.now();
    this.assertOwned(id);
    if (!this.historyRead || this.prompted) return unavailable(request, started);
    const history = this.history, shifted = history.summaries.length > 0, oldest = history.users[0]?.index ?? history.total;
    const clients = history.users.filter(entry => !entry.summary && !entry.injected);
    let foreign: number | null = null;
    const results = request.markers.map((marker, position): MarkerResult => {
      if (marker.position.kind !== "seq") return "unavailable";
      const before = marker.position.before, packetId = marker.packetId;
      const carries = (entry: ReplayHistory["users"][number], whole: boolean) => entry.titled === packetId && (!whole || entry.whole);
      const after = clients.filter(entry => entry.index >= before), at = packetEntry(after, carries);
      const found = at >= 0 ? after[at] : shifted ? clients.find(entry => carries(entry, true)) : undefined;
      if (found !== undefined) { if (position === request.markers.length - 1) foreign = clients.filter(entry => entry.index > found.index).length; return "present"; }
      if (history.users.some(entry => entry.summary && entry.titled === packetId)) return "compacted";
      return before < oldest && history.total > history.users.length ? "outside_window" : "absent";
    });
    return verifyResult(request, results, started, { historyEmpty: request.historyEmpty ? history.total === 0 && history.others === 0 : null,
      compaction: { count: history.summaries.length, digest: cursorDigest(history.summaries) }, foreignAfterLast: foreign });
  }
  /**
   * `/queue` and `/steer` submit their arguments as a prompt (gateway_commands.py `_prompt`, `_steer`): the packet goes into
   * the arguments, the command word first, so the viewer still runs the command and Hermes records the packet and the words.
   * A bare command (Hermes answers it with its usage) carries none.
   */
  protected override relayParts(turn: RelayTurn, attachments: readonly ContentKind[]): readonly string[] | null {
    const reading = hermesRelayCapabilities.commands.classify(turn.user, this.announced, attachments);
    if (reading.kind !== "command" || reading.acceptsRelay !== true) return super.relayParts(turn, attachments);
    const named = commandOf(turn.user);
    return named === null || named.args === "" ? null : ["/" + named.word, ...placeTurn({ ...turn, user: named.args }, hermesRelayCapabilities.placement)];
  }
  /** The steer wrapper Hermes writes around a user's words (agent/prompt_builder.py) is harness text. */
  protected override nativeWrapping(replayed: string): UserText {
    const steer = STEER.exec(replayed);
    return steer === null ? { user: replayed, stripped: [] } : { user: steer[2]!, stripped: strip(strip([], "harness_text", steer[1]!), "harness_text", steer[3]!) };
  }
  /**
   * Names the session in Hermes before its first relayed prompt (ADR-055 §8.1, D3): `/title <title>`, which the viewer answers
   * itself (`_run_slash` → `_rename`, a metadata change) without a gateway turn or a history row; its receipt is swallowed. One
   * line of at most 200 characters; an empty title is not sent (a bare `/title` goes to the gateway). Rejects with
   * NATIVE_TITLE_UNAVAILABLE when Hermes does not confirm it, also when it does not answer within TITLE_DEADLINE_MS: the prompt
   * is then given up alone and the connection stays usable (C6). Not enabled: the Runtime does not call it before a probe
   * (the approval agent's B10).
   */
  async setTitle(id: NativeConversationId, title: string): Promise<void> {
    this.assertOwned(id);
    const name = [...title.replace(/[\0-\x1f\x7f\u2028\u2029\u0085]+/gu, " ").trim()].slice(0, 200).join("").trim();
    if (!name) return;
    let reply = "";
    // A prompt all the same: the replay read at open no longer counts as the history (F7).
    this.prompted = true;
    const run = await super.sendPrompt(id, "/title " + name, event => { if (event.type === "text" && reply.length < 4096) reply += event.text; }, [], TITLE_DEADLINE_MS);
    const result = await run.result;
    if (result.status !== "completed" || !TITLE_SET.test(reply.trim())) throw new ControlError("NATIVE_TITLE_UNAVAILABLE", "Hermes did not confirm the session title");
  }
  /** `preflight` judges the user's gateway before `hermes acp` is started (ADR-051 A2); tests inject a judgement, the factory keeps the real reader. */
  constructor(private readonly hermesLaunch: ControlLaunch, private readonly hermesOptions: ControlOptions, private readonly preflight: HermesGatewayPreflight = hermesGatewayPreflight) { super(hermesLaunch, hermesOptions); }
  /**
   * ADR-051 A2 condition 1: the viewer is started only when a compatible gateway is already running (verdict A). Anything
   * else the viewer would do to the user's gateway — stop and replace it (B), wait a minute for it (C), start its launchd
   * service (D) or an unsupervised daemon (E) — is refused here, before any process exists, with the Hermes commands that
   * put it right. A checkout without the viewer runs its sessions in-process and is not judged. The facts are read when
   * the connection is made, so the gateway can still change before session/new: the message says so.
   */
  protected override async beforeConnect(): Promise<void> {
    const judged = await this.preflight({ ...this.hermesOptions.env, ...this.hermesLaunch.env }, this.hermesLaunch.executable);
    if (judged.kind === "refuse") throw new ControlError("NATIVE_GATEWAY_UNAVAILABLE", gatewayRefusalMessage(judged));
  }
  protected override get restoreByLoad(): boolean { return true; }
  protected override get fileBlocks(): boolean { return false; }
  // ADR-053's registered exception: 0.12's bridge announces a fixed 60-second wait; later versions make it configurable and
  // do not report it, so nothing is claimed for them. Removed when the Hermes gateway view lands.
  protected override get approvalDeadlineMs(): number | null { return /^0\.12\./u.test(this.agentVersion ?? "") ? HERMES_APPROVAL_WAIT_MS : null; }
  // A call whose text says it failed did fail, whatever status Hermes reported for it.
  protected override toolStatus(status: string, detail: NativeToolDetail | undefined): string { return status === "completed" && TOOL_FAILURE.test(detail?.output ?? "") ? "failed" : status; }
  // Hermes can send its last reply chunks after the prompt response (Multica waits 250 ms for the same reason).
  protected override get trailingQuietMs(): number { return HERMES_TRAILING_QUIET_MS; }
  // The option ids say what an option does (acp_adapter/permissions.py: allow_session is also of kind allow_always). An agent
  // with none of these ids gets the note on its allow_always kind, as 0.12's "always" wrote command_allowlist (tools/approval.py).
  protected override permissionNote(options: readonly { readonly id: string; readonly kind: string; readonly name: string }[]): string {
    const noted = options.filter(option => Object.hasOwn(OPTION_NOTES, option.id));
    if (noted.length) return noted.map(option => OPTION_NOTES[option.id]!(option.name)).join("\n");
    const always = options.find(option => option.kind === "allow_always");
    return always ? OPTION_NOTES.allow_always!(always.name) : "";
  }
  protected override refusal(method: string, error: ControlError, report?: (event: ControlEvent) => void): { readonly code: string; readonly message: string } | null {
    const detail = error.remoteDetail ?? "";
    if ((method === "session/load" || method === "session/resume") && NOT_FOUND.test(detail)) return { code: "NATIVE_SESSION_NOT_FOUND", message: "the Harness has no session with this identity" };
    const gateway = GATEWAY_UNAVAILABLE.exec(detail);
    if (gateway) return { code: "NATIVE_GATEWAY_UNAVAILABLE", message: `Hermes 的网关当前不可用（Gateway ${gateway[1]}${gateway[2] === undefined ? "" : ": " + gateway[2]}），这次请求没有送达网关。可以在 Hermes 里查看网关状态（hermes gateway status）后再试。` };
    // An unknown outcome is not a failure of the request, but BackendResult has no unknown yet: the Run keeps the generic
    // refusal, and the Turn records what Hermes asks for before the session can go on. While that turn is pending Hermes
    // refuses every other prompt unsent, which is then safe to send again once the turn is discarded.
    if (report !== undefined && UNKNOWN_OUTCOME.test(detail)) {
      const admission = DISCARD.exec(detail)?.[1], discard = admission === undefined ? "/discard <admission_id>" : "/discard " + admission;
      report({ type: "diagnostic", message: NOT_SUBMITTED.test(detail)
        ? `Hermes 没有接收这条消息：这个会话里有一个回合在 Hermes 网关重启时丢失、结果未知，放弃它之前 Hermes 不接受新消息。先在 Hermes 里放弃它（${discard}，或 hermes sessions discard <会话 ID>），再重新发送这条消息。`
        : `Hermes 说这条消息的执行结果未知：它可能已经执行，不要重发。要继续这个会话，先在 Hermes 里放弃它（${discard}，或 hermes sessions discard <会话 ID>）。` });
    }
    return null;
  }
  // Hermes refuses these before its gateway admitted anything: while connecting to the gateway, for a session it does not
  // have, when the owner refuses the submit, and while a lost turn is pending.
  protected override refusedPrompt(error: ControlError): "recorded" | "not_recorded" | null {
    const detail = error.remoteDetail ?? "";
    return GATEWAY_UNAVAILABLE.test(detail) || NOT_SUBMITTED.test(detail) || NOT_ADMITTED.test(detail) ? "not_recorded" : null;
  }
  // acp_adapter/auth.py: the agent method's id is the configured provider, present only when its credentials resolve.
  protected override authentication(methods: readonly { readonly id: string; readonly type: string }[]): NativeModelCatalog["authentication"] { return methods.some(method => method.type === "agent") ? "ready" : "missing"; }
  // The viewer writes the user turn to the session before its first model call, so end_turn means it was recorded.
  protected override promptRecorded(reason: string): boolean { return reason === "end_turn"; }
  // A slash word in neither the registry copy nor the catalog is prompt text for v0.22.5, but a later Hermes may run it as a
  // command, so its end is no evidence of recorded content: if the copy is out of date its facts are sent once more, never lost.
  protected override readsAsContent(prompt: string, attachments: readonly ContentKind[]): boolean {
    if (!super.readsAsContent(prompt, attachments)) return false;
    const named = readsSlash(attachments) ? commandOf(prompt) : null;
    return named === null || !COMMAND_WORD.test(named.word);
  }
  override classify(text: string, catalog: NativeModelCatalog | null, attachments: readonly ContentKind[] = []): CommandClass { return hermesNativeClassify(text, catalog, attachments); }
  override async startText(id: NativeConversationId, turn: TurnText, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    // A relay Turn whose words read as a command is refused before anything below runs (the export included).
    const refusal = this.relayRefused(turn, attachments.map(file => file.kind));
    if (refusal !== null) return refusal;
    // The commands the driver reads (export, model, compress, clear) are read in the user's words; the base driver places a packet.
    const prompt = typeof turn === "string" ? turn : turn.user;
    // The same reading as classify(): a registry command by its name and arguments, and none with an image.
    const named = readsSlash(attachments.map(file => file.kind)) ? commandOf(prompt) : null, command = named === null ? undefined : REGISTRY.get(named.word.toLowerCase());
    // The Hub's export is `/export` alone: with a file its pointer text becomes the arguments Hermes sees.
    if (this.hubExport && !attachments.length && command === EXPORT.name && named?.args === "") {
      return { result: this.exportSession(id, onEvent), requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "an export has no native turn to stop")) };
    }
    // Only Hermes's own command is read for a model switch; a model reply quoting the same words in another turn is never parsed.
    const switching = command === "model" && named?.args !== "", compressing = command === "compress", clearing = command === "new" || command === "clear", mark = this.stderrMark;
    let reply = "", answered = false;
    // From this prompt on, the replay read at open no longer holds the history (F7).
    this.prompted = true;
    const run = await super.startText(id, turn, event => { if (event.type === "text") { answered = true; if (reply.length < 4096) reply += event.text; } onEvent(event); }, attachments);
    return { ...run, result: run.result.then((result): BackendResult => {
      const switched = switching ? MODEL_SWITCHED.exec(reply) : null;
      // Hermes lists models as `<provider>:<model>` with the provider lower-cased (server.py `_encode_model_choice`).
      if (result.status === "completed" && switched) this.adoptModel(switched[2]!.toLowerCase() + ":" + switched[1]!);
      // The viewer answers a /compress that removed nothing in its own fixed words: the command ran and changed nothing.
      if (compressing && result.status === "completed" && COMPRESS_NOOP.test(reply.replace(LEADING_SPACE, ""))) return { ...result, command: "noop" };
      // The viewer's fixed receipt of a reset is the only confirmation that the history was cleared (ADR-055 §7.4, F04); any
      // other answer leaves the clear unconfirmed.
      if (clearing && result.status === "completed" && reply.trim() === CLEARED) return { ...result, native: { cleared: true, replaced: null } };
      // A failed model call still ends with end_turn: nothing is answered (or only Hermes's own "Error: …"), and its log says why.
      // The prompt was in the session before that call, so what the end_turn proved stays proven.
      if (result.status === "completed" && (!answered || reply.startsWith("Error: "))) {
        const logged = this.stderrSince(mark);
        if (answered ? AGENT_ERROR.test(logged) : TERMINAL_FAILURE.test(logged))
          return { status: "failed", reason: "native_error", error: classifyRemoteFailure(logged) ?? { code: "MODEL_REQUEST_FAILED", message: "Hermes 的模型请求失败了，原因记录在 Hermes 自己的日志里。" }, ...(result.input === undefined ? {} : { input: result.input }) };
      }
      return result;
    }) };
  }
  override async models(): Promise<NativeModelCatalog> {
    const catalog = await super.models(), listed = (catalog.commands ?? []).map(command => {
      // Hermes announces some commands by alias (`reset` for new): the effect is its registry name's.
      const name = REGISTRY.get(command.name.toLowerCase());
      return { ...command, contextEffect: (name === undefined ? undefined : EFFECTS[name]) ?? command.contextEffect ?? "unknown" };
    });
    this.hubExport = !listed.some(command => command.name === EXPORT.name);
    return { ...catalog, commands: this.hubExport ? [...listed, EXPORT] : listed, hiddenCommands: HIDDEN };
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
      // The export reads Hermes's own record of the session; nothing reaches its gateway.
      return { status: "completed", reason: "exported", input: "not_recorded" };
    } catch (error) {
      const message = error instanceof ControlError && error.code === "NATIVE_EXPORT_UNAVAILABLE" ? error.message
        : error instanceof ControlError && error.code === "OUTPUT_LIMIT" ? "the Hermes export exceeds 8 MiB"
        : error instanceof ControlError && error.code === "REQUEST_TIMEOUT" ? "the Hermes export took longer than 5 seconds" : "Hermes could not export this session";
      return { status: "failed", reason: "export_failed", error: { code: "NATIVE_EXPORT_UNAVAILABLE", message }, input: "not_recorded" };
    }
  }
  override async close(): Promise<CleanupEvidence> { this.exports.abort(); return super.close(); }
}
