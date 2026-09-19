import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { ServerResponse } from "node:http";
import type { HubApplication } from "../../application/service.js";
import { isTerminal } from "../../domain/types.js";
import type {
  AgentEvent,
  JsonValue,
  PublicError,
  RunId,
  SessionId,
} from "../../domain/types.js";
import { RunTranscript, failureOf, terminalStatusOf } from "./transcript.js";

const POLL_MS = 25;
const DISCOVERY_MS = 1_000;
const HEARTBEAT_MS = 15_000;
const EVENT_BATCH = 200;
const REPLAY_BATCH = 1_000;

/**
 * In-process notice of Runs accepted through `prompt_async`, so open event streams
 * start following them without scanning Run history. Listeners must not throw.
 */
export class CompetitionRunFeed {
  private readonly listeners = new Set<(id: RunId) => void>();

  /** Registers a listener until the returned function is called. */
  subscribe(listener: (id: RunId) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(id: RunId): void {
    for (const listener of this.listeners) listener(id);
  }
}

interface Followed {
  id: RunId;
  cursor: number;
  transcript: RunTranscript;
}

/**
 * Streams Competition v1.1 SSE frames until `signal` aborts or writing fails.
 *
 * Only committed Run events drive the output, so every followed Run yields
 * `session.status busy` before its parts and, once no other Run of the Session is
 * unfinished, `session.status idle` plus `session.idle` after its terminal event,
 * even when it starts and ends between two polls. Failed, timed-out and interrupted
 * Runs emit `session.error` first. A new stream follows unfinished Runs from their
 * current position (announcing their Sessions as busy) and every later Run from its
 * first event; finished history is never replayed. Runs are found through `feed` and
 * a history scan once per second; only unfinished or not yet drained Runs are polled.
 * The caller owns `response` and ends it after this promise settles.
 */
export async function streamCompetitionEvents(
  app: HubApplication,
  feed: CompetitionRunFeed,
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  const followed = new Map<RunId, Followed>();
  const known = new Set<RunId>();
  const announced = new Map<SessionId, "busy" | "idle">();
  const notified: RunId[] = [];
  let frames: string[] = [];
  let lastTextKey: string | undefined;

  const frame = (type: string, properties: object, textKey?: string) => {
    const data = `data: ${JSON.stringify({ type, properties })}\n\n`;
    // Consecutive states of one text part collapse into the latest state.
    if (textKey !== undefined && textKey === lastTextKey)
      frames[frames.length - 1] = data;
    else frames.push(data);
    lastTextKey = textKey;
  };
  const flush = async () => {
    if (!frames.length) return;
    const chunk = frames.join("");
    frames = [];
    lastTextKey = undefined;
    if (!response.write(chunk)) await once(response, "drain", { signal });
  };
  const busy = (sessionId: SessionId) => {
    if (announced.get(sessionId) === "busy") return;
    announced.set(sessionId, "busy");
    frame("session.status", { sessionID: sessionId, status: { type: "busy" } });
  };
  const follow = (id: RunId, cursor: number, transcript: RunTranscript) => {
    followed.set(id, { id, cursor, transcript });
  };
  const project = (entry: Followed, event: AgentEvent): boolean => {
    const sessionId = event.sessionId;
    busy(sessionId);
    for (const update of entry.transcript.apply(event))
      frame(
        "message.part.updated",
        {
          sessionID: sessionId,
          messageID: update.messageID,
          part: update.part,
        },
        update.part.type === "text" ? update.part.id : undefined,
      );
    const status = terminalStatusOf(event);
    if (!status) return false;
    const failure = failureOf(
      status,
      publicError(event.data.error),
      typeof event.data.stopReason === "string"
        ? event.data.stopReason
        : undefined,
    );
    if (failure)
      frame("session.error", {
        sessionID: sessionId,
        error: {
          message: failure.message,
          data: { code: failure.code, runId: event.runId },
        },
      });
    const pending = app
      .runs(sessionId)
      .some((run) => run.id !== event.runId && !isTerminal(run.status));
    if (!pending) {
      announced.set(sessionId, "idle");
      frame("session.status", {
        sessionID: sessionId,
        status: { type: "idle" },
      });
      frame("session.idle", { sessionID: sessionId });
    }
    return true;
  };

  const unsubscribe = feed.subscribe((id) => {
    notified.push(id);
  });
  try {
    frame("server.connected", {});
    for (const run of app.runs()) {
      known.add(run.id);
      if (isTerminal(run.status)) continue;
      // Rebuild part state silently so later updates carry complete content.
      const transcript = new RunTranscript(run.id);
      let cursor = 0;
      replay: while (cursor < run.lastSeq) {
        const batch = app.events(run.id, cursor, REPLAY_BATCH);
        if (!batch.length) break;
        for (const event of batch) {
          if (event.seq > run.lastSeq) break replay;
          transcript.apply(event);
          cursor = event.seq;
        }
      }
      follow(run.id, cursor, transcript);
      busy(run.sessionId);
    }
    await flush();
    let discoveredAt = Date.now();
    let heartbeatAt = Date.now();
    while (!signal.aborted) {
      for (const id of notified.splice(0))
        if (!known.has(id)) {
          known.add(id);
          follow(id, 0, new RunTranscript(id));
        }
      if (Date.now() - discoveredAt >= DISCOVERY_MS) {
        discoveredAt = Date.now();
        for (const run of app.runs())
          if (!known.has(run.id)) {
            known.add(run.id);
            follow(run.id, 0, new RunTranscript(run.id));
          }
      }
      for (const entry of followed.values()) {
        for (const event of app.events(entry.id, entry.cursor, EVENT_BATCH)) {
          entry.cursor = event.seq;
          if (project(entry, event)) {
            followed.delete(entry.id);
            break;
          }
        }
        await flush();
      }
      if (Date.now() - heartbeatAt >= HEARTBEAT_MS) {
        heartbeatAt = Date.now();
        frame("server.heartbeat", {});
        await flush();
      }
      await delay(POLL_MS, undefined, { signal });
    }
  } finally {
    unsubscribe();
  }
}

function publicError(value: JsonValue | undefined): PublicError | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const { code, message } = value;
  return typeof code === "string" && typeof message === "string"
    ? { code, message }
    : undefined;
}
