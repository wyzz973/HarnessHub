import type { ContentRef } from "../contracts/content.js";
import type { SessionSnapshot } from "../contracts/session.js";
import type { KeptProcessView, SessionView, WebRun } from "../contracts/web.js";
import { carriedNativeConfiguration } from "../contexts/session/domain/state.js";
import { projectTurns, type ToolDetailInput } from "../contexts/session/domain/protocol/index.js";

/*
 * The conversation in the shape of the old view (`SessionView`: every Run with its protocol Turn, the messages, the switches), which the export still is made from
 * (`conversationMarkdown` in conversation-export.ts and the JSON export). The page no longer reads this shape: it reads the head and the Turns of a window. This is the one reader
 * of a whole conversation in the old shape that the server keeps, until the export is made from the rows (the readers' line) — then this file goes.
 */

/** What only the running service knows of a conversation, as the export carries it. */
type Retention = NonNullable<SessionView["retention"]>;
export interface ExportLive {
  readonly kept: KeptProcessView | null;
  readonly lost: NonNullable<Retention["lost"]> | null;
  readonly queue: NonNullable<SessionView["queue"]> | null;
  readonly outside: NonNullable<Retention["outside"]> | null;
  readonly upgraded: NonNullable<Retention["upgraded"]> | null;
}
/** The names and the details the protocol's reading of a Run brings. */
export interface ExportNames {
  readonly harnessName: (harnessId: string) => string | null;
  readonly modelName?: (harnessId: string, nativeModel: string) => string | null;
  readonly detail: (ref: ContentRef) => ToolDetailInput | null;
}

/** `runs` are the snapshot's Runs with the relay's delivery state read in, in the same order. */
export function exportView(snapshot: SessionSnapshot, runs: readonly WebRun[], live: ExportLive, names: ExportNames): SessionView {
  const turns = projectTurns({ runs, messages: snapshot.messages, nativeBindings: snapshot.nativeBindings, waiting: new Set() },
    { harnessName: names.harnessName, ...(names.modelName === undefined ? {} : { modelName: names.modelName }), detail: names.detail });
  return { id: snapshot.id, version: snapshot.version, lastSeq: snapshot.lastSeq, epoch: snapshot.epoch, status: snapshot.status,
    workspace: snapshot.configuration.workspace, selection: snapshot.selection, activeRunId: snapshot.activeRunId, pendingSwitchId: snapshot.pendingSwitchId,
    permissions: [], nativeStates: snapshot.nativeBindings?.flatMap(binding => {
      if (binding.status === "archived") return [];
      const carried = binding.harnessId === snapshot.selection.harnessId && binding.controlId === snapshot.selection.controlId ? carriedNativeConfiguration(snapshot, snapshot.selection, snapshot.epoch) : null;
      return [{ harnessId: binding.harnessId, controlId: binding.controlId, status: binding.status === "fork-pending" || binding.status === "forking" ? "forking" as const : binding.status,
        ...(binding.observed === undefined ? {} : { observed: binding.observed }), ...(carried === null ? {} : { carried }) }];
    }) ?? [],
    ...(snapshot.origin === undefined ? {} : { origin: snapshot.origin }), ...(live.queue === null ? {} : { queue: live.queue }),
    ...(snapshot.schemaVersion < 11 ? {} : { retention: { enabled: snapshot.retainNative === true, process: live.kept, ...(live.lost === null ? {} : { lost: live.lost }), ...(live.outside === null ? {} : { outside: live.outside }),
      ...(live.upgraded === null ? {} : { upgraded: live.upgraded }) } }),
    messages: snapshot.messages, runs: runs.map((run, index) => ({ ...run, protocol: turns[index]! })), switches: snapshot.switches };
}
