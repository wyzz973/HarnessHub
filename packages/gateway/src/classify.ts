// SPDX-License-Identifier: MIT
/**
 * The classifier of a route group (Magpie `gw/classify.go`): as a user's
 * turn begins, a model the group names is asked which of the rules'
 * intents the user's message is and, for a group with `effort: "auto"`,
 * how much reasoning the turn wants. The call goes through the gateway
 * itself as an internal call of the request's Gateway Key (./internal.js),
 * so the classifier is any model or group the key may use, with its
 * credentials, failover and ledger entry (agent `harnesshub-classify`,
 * purpose `classify`). An answer is kept for 10 minutes for the same
 * message. A classifier that could not be reached (no answer in time, a
 * connection failure or a 5xx) is not asked again for 30 seconds, and
 * meanwhile no intent matches, so the group routes as it would without
 * those rules; one that refused the question (a 4xx, such as the key's
 * own budget) or answered something else than a number alone is up, and
 * is asked again at once. The user's message is a routing hint, not a
 * security boundary: it can steer the answer among the group's members.
 * What is kept of a failure never holds the answer's or the upstream's
 * text.
 */
import type { ReasoningEffort } from "@harnesshub/core/model-plane";
import { createHash } from "node:crypto";
import { deadline } from "./http.js";
import { record } from "./protocol.js";

/** How long one question to the classifier may take. */
export const CLASSIFY_TIMEOUT_MS = 8_000;
/** How long an answer is kept for the same message and intents. */
export const CLASSIFY_KEEP_MS = 10 * 60_000;
/** After a failure, how long the classifier is left alone. */
export const CLASSIFY_REST_MS = 30_000;
/** Answers and failures remembered. */
const REMEMBERED = 4096;

/** The levels the classifier picks a turn's reasoning from (Magpie `jevLevels`). */
export const PICK_LEVELS: ReadonlyArray<{
  effort: ReasoningEffort;
  what: string;
}> = [
  {
    effort: "low",
    what: "Little to think about: a greeting, a question answered from what is already known, a mechanical or one-line change, running a command",
  },
  {
    effort: "medium",
    what: "Some thought: an ordinary bug fix or a small feature in code already understood",
  },
  {
    effort: "high",
    what: "Careful thought: a change across several files, a bug whose cause is not known yet, a design choice with trade-offs",
  },
  {
    effort: "xhigh",
    what: "Deep thought: a subtle bug (concurrency, performance, security), an architecture or algorithm to design, a long multi-step plan",
  },
];

/** A Chat request through the gateway: its status and parsed body. */
export type AskChat = (
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<{ status: number; body: unknown }>;

/** What the classifier said of the conversation's turn before, which it is told. */
export interface Before {
  intent?: string;
  effort?: string;
}

/** What the classifier said: the intent (none when undefined) and the turn's reasoning when asked. */
export interface Verdict {
  intent?: string;
  effort?: ReasoningEffort;
}

/** The outcome of one {@link Classifier.classify}. */
export interface Classification {
  verdict: Verdict;
  /** Said before, for the same message. */
  cached: boolean;
  /** Why it could not say; the verdict is then empty. */
  error?: string;
  /** Not asked: it failed less than {@link CLASSIFY_REST_MS} ago. */
  resting?: boolean;
}

/** The classifier could not be reached: it rests for {@link CLASSIFY_REST_MS}. */
class Unreachable extends Error {}

const SYSTEM_INTENT =
  "You route a user's message to a coding assistant. " +
  "Given numbered kinds and the user's message, answer with the number of the kind that fits the message best. " +
  "The kinds may be topics, or levels such as how hard or how big a request is; " +
  "when they are levels, every message has one, a greeting or a question about the assistant included. " +
  "Answer 0 only when the message is plainly none of the kinds. Answer with the number only.";

const SYSTEM_EFFORT =
  "You judge how much reasoning a coding assistant needs to handle a user's message well. " +
  "Given numbered levels and the user's message, answer with the number of the level it needs. Answer with the number only.";

function chatBody(model: string, system: string, user: string) {
  return {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: false,
    temperature: 0,
    // A model that reasons does so before the number.
    max_tokens: 2048,
  };
}

/** The Chat request asking which of `intents` the message is (Magpie `classifyBody`). */
export function intentBody(
  model: string,
  intents: readonly string[],
  before: string | undefined,
  text: string,
): Record<string, unknown> {
  let user = `Kinds:\n${intents.map((intent, index) => `${index + 1}. ${intent}\n`).join("")}`;
  const was = before === undefined ? -1 : intents.indexOf(before);
  if (was >= 0)
    user +=
      `\nThe user's message before this one, in the same conversation, was of kind ${was + 1}. ` +
      `A message that only carries on from it — go on, yes, do it, fix that — is of kind ${was + 1} too; ` +
      "one that asks for something of its own is of the kind that fits it.\n";
  user += `\nThe user's message:\n<message>\n${escaped(text)}\n</message>\n\nThe number of the kind that fits it best (0 only if none does):`;
  return chatBody(model, SYSTEM_INTENT, user);
}

/** The Chat request asking how much reasoning the message needs (Magpie `effortBody`). */
export function effortBody(
  model: string,
  before: string | undefined,
  text: string,
): Record<string, unknown> {
  let user = `Levels:\n${PICK_LEVELS.map((level, index) => `${index + 1}. ${level.effort}: ${level.what}\n`).join("")}`;
  const was = PICK_LEVELS.findIndex((level) => level.effort === before);
  if (was >= 0)
    user +=
      `\nThe user's message before this one, in the same conversation, needed level ${was + 1}. ` +
      `A message that only carries on from it — go on, yes, do it — needs level ${was + 1} too.\n`;
  user += `\nThe user's message:\n<message>\n${escaped(text)}\n</message>\n\nThe number of the level it needs:`;
  return chatBody(model, SYSTEM_EFFORT, user);
}

/** The user's text inside the prompt's tags: it cannot close `<message>` or open another tag. */
function escaped(text: string): string {
  return text.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The number an answer is, when it is a number alone (spaces around it allowed). */
function number(answer: string): number {
  return /^\s*\d+\s*$/.test(answer) ? Number(answer) : Number.NaN;
}

/** Why an answer is no number in range: its length only, never its text. */
function notANumber(answer: string, range: string): Error {
  return new Error(
    `it answered ${[...answer].length} characters, not a number alone from ${range}`,
  );
}

/** The intent an answer names, when it is a number alone; undefined for 0. */
export function readIntent(
  answer: string,
  intents: readonly string[],
): string | undefined {
  const found = number(answer);
  if (!Number.isSafeInteger(found) || found > intents.length)
    throw notANumber(answer, `0 to ${intents.length}`);
  return found === 0 ? undefined : intents[found - 1];
}

/** The level an answer names, when it is a number alone. */
export function readEffort(answer: string): ReasoningEffort {
  const found = number(answer);
  if (!Number.isSafeInteger(found) || found < 1 || found > PICK_LEVELS.length)
    throw notANumber(answer, `1 to ${PICK_LEVELS.length}`);
  return PICK_LEVELS[found - 1]!.effort;
}

/**
 * A route group's classifier calls, owned by one gateway handler: answers
 * kept per message for {@link CLASSIFY_KEEP_MS}, unreachable classifiers
 * for {@link CLASSIFY_REST_MS}. In memory only.
 */
export class Classifier {
  #answers = new Map<string, { verdict: Verdict; at: number }>();
  #failed = new Map<string, { error: string; at: number }>();
  constructor(private readonly clock: () => number) {}

  /**
   * Ask `model` through `ask` (the request's own internal calls) which of
   * `intents` the message `text` is (when there are any) and, with
   * `effort`, how much reasoning it needs; both at once, each within
   * {@link CLASSIFY_TIMEOUT_MS}. Never rejects: a failure is the outcome's
   * `error`, and the verdict is then empty.
   */
  async classify(
    model: string,
    intents: readonly string[],
    before: Before,
    effort: boolean,
    text: string,
    ask: AskChat,
    signal: AbortSignal,
  ): Promise<Classification> {
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          model,
          intents.map((intent) => intent.toLowerCase()),
          before.intent ?? "",
          before.effort ?? "",
          effort,
          text,
        ]),
      )
      .digest("hex");
    const now = this.clock();
    const kept = this.#answers.get(key);
    if (kept && now - kept.at < CLASSIFY_KEEP_MS)
      return { verdict: kept.verdict, cached: true };
    const failed = this.#failed.get(model);
    if (failed && now - failed.at < CLASSIFY_REST_MS)
      return {
        verdict: {},
        cached: false,
        resting: true,
        error: `${model} failed ${Math.round((now - failed.at) / 1000)} s ago (${failed.error}); not asked again for now`,
      };
    const verdict: Verdict = {};
    try {
      await Promise.all([
        intents.length
          ? this.#answer(
              model,
              intentBody(model, intents, before.intent, text),
              ask,
              signal,
            ).then((answer) => {
              const intent = readIntent(answer, intents);
              if (intent !== undefined) verdict.intent = intent;
            })
          : undefined,
        effort
          ? this.#answer(
              model,
              effortBody(model, before.effort, text),
              ask,
              signal,
            ).then((answer) => {
              verdict.effort = readEffort(answer);
            })
          : undefined,
      ]);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "the classifier failed";
      if (error instanceof Unreachable)
        this.#remember(this.#failed, model, {
          error: message,
          at: this.clock(),
        });
      return { verdict: {}, cached: false, error: message };
    }
    this.#failed.delete(model);
    this.#remember(this.#answers, key, { verdict, at: this.clock() });
    return { verdict, cached: false };
  }

  /**
   * The text of the model's answer to `body`; rejects with why there is
   * none, an {@link Unreachable} when the classifier should rest. The
   * reason names the status only, never the upstream's message.
   */
  async #answer(
    model: string,
    body: Record<string, unknown>,
    ask: AskChat,
    signal: AbortSignal,
  ): Promise<string> {
    const timeout = deadline(signal, CLASSIFY_TIMEOUT_MS);
    try {
      let answer: { status: number; body: unknown };
      try {
        answer = await ask(body, timeout.signal);
      } catch {
        throw new Unreachable(
          timeout.expired()
            ? `${model} gave no answer in ${CLASSIFY_TIMEOUT_MS / 1000} s`
            : `${model} was not reached`,
        );
      }
      const value = record(answer.body);
      if (answer.status >= 500)
        throw new Unreachable(`${model}: status ${answer.status}`);
      if (answer.status >= 300 || !value || value.error !== undefined)
        throw new Error(`${model}: status ${answer.status}`);
      const choice = record(
        Array.isArray(value.choices) ? value.choices[0] : undefined,
      );
      const content = record(choice?.message)?.content;
      if (typeof content !== "string")
        throw new Error(`${model} gave no answer`);
      return content;
    } finally {
      timeout.dispose();
    }
  }

  #remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key);
    map.set(key, value);
    for (const oldest of map.keys()) {
      if (map.size <= REMEMBERED) break;
      map.delete(oldest);
    }
  }
}
