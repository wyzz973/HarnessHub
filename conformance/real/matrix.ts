// SPDX-License-Identifier: MIT
/**
 * The official-SDK matrix against a running gateway in front of real
 * upstreams, for `pnpm test:real` (tests/real/check.ts, which starts the
 * gateway, runs this program and reads its output). It reaches the gateway
 * only over HTTP with the clients of conformance/protocols/clients.ts, so
 * it runs against any gateway.
 *
 * Usage: HH_REAL_GATEWAY_URL=URL HH_REAL_GATEWAY_KEY=KEY
 *   node dist/conformance/real/matrix.js --model REF... [--attempts 3]
 *
 * For each model, inbound protocol and stream mode: a text turn that must
 * answer with the word OK, and a tool round trip that must call
 * `get_weather` and answer after its result. A turn the model gets wrong
 * (it may, being a model) is tried again, up to `--attempts` times in all,
 * and every miss is reported; an error is reported at once. Prints one JSON
 * line per row and nothing secret; exits 1 when a row failed, 2 for bad
 * arguments.
 */
import { parseArgs } from "node:util";
import {
  conversation,
  failureOf,
  type ToolSpec,
  type Turn,
} from "../protocols/clients.js";
import { PROTOCOLS, type Protocol } from "../protocols/target.js";

const WEATHER: ToolSpec = {
  name: "get_weather",
  description: "Current weather for a city",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};
const TEXT_PROMPT = "Reply with exactly the word OK and nothing else.";
const TOOL_PROMPT =
  "What is the weather in Paris? Call get_weather, then answer in one short sentence.";
const WEATHER_RESULT = '{"condition":"sunny","celsius":21}';

/** The result of one check of a row, after its attempts. */
export interface Outcome {
  result: "pass" | "fail";
  attempts: number;
  /** What happened in the last attempt. */
  detail: string;
  /** What each earlier attempt got wrong. */
  misses: string[];
}

/** One line of output. */
export interface MatrixRow {
  model: string;
  protocol: Protocol;
  stream: boolean;
  text: Outcome;
  tool: Outcome;
}

/** A turn's miss, or undefined when it did what was asked. */
type Check = () => Promise<{ miss?: string; detail: string }>;

const clip = (text: string, length = 60) =>
  text.replace(/\s+/g, " ").trim().slice(0, length);

async function attempt(check: Check, attempts: number): Promise<Outcome> {
  const misses: string[] = [];
  for (let count = 1; ; count++) {
    let outcome: { miss?: string; detail: string };
    try {
      outcome = await check();
    } catch (error) {
      const failure = failureOf(error);
      return {
        result: "fail",
        attempts: count,
        detail: `error: ${[failure.status, failure.code, clip(failure.message, 200)].filter(Boolean).join(" ")}`,
        misses,
      };
    }
    if (outcome.miss === undefined)
      return {
        result: "pass",
        attempts: count,
        detail: outcome.detail,
        misses,
      };
    if (count >= attempts)
      return { result: "fail", attempts: count, detail: outcome.miss, misses };
    misses.push(outcome.miss);
  }
}

function usage(turn: Turn): string {
  return turn.usage
    ? `${turn.usage.input}/${turn.usage.output} tokens`
    : "no usage";
}

async function row(
  model: string,
  protocol: Protocol,
  stream: boolean,
  options: { url: string; key: string; attempts: number },
): Promise<MatrixRow> {
  const client = () => conversation(protocol, model, options);
  const text = await attempt(async () => {
    const turn = await client().ask({
      stream,
      text: TEXT_PROMPT,
      maxTokens: 64,
    });
    return /\bok\b/i.test(turn.text)
      ? { detail: `"${clip(turn.text, 20)}", ${turn.finish}, ${usage(turn)}` }
      : {
          miss: `answered "${clip(turn.text)}" (${turn.finish}) instead of OK`,
          detail: "",
        };
  }, options.attempts);
  const tool = await attempt(async () => {
    const chat = client();
    const call = await chat.ask({
      stream,
      text: TOOL_PROMPT,
      tools: [WEATHER],
      maxTokens: 512,
    });
    const weather = call.toolCalls.find((item) => item.name === WEATHER.name);
    if (!weather)
      return {
        miss: `answered without calling get_weather (${call.finish}): "${clip(call.text)}"`,
        detail: "",
      };
    const done = await chat.answer(
      call.toolCalls.map((item) => ({ call: item, output: WEATHER_RESULT })),
      { stream, tools: [WEATHER], maxTokens: 512 },
    );
    return done.text.trim()
      ? {
          detail: `get_weather(${clip(weather.arguments, 30)}) → "${clip(done.text, 40)}"`,
        }
      : {
          miss: `no answer after the tool result (${done.finish})`,
          detail: "",
        };
  }, options.attempts);
  return { model, protocol, stream, text, tool };
}

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        model: { type: "string", multiple: true },
        attempts: { type: "string", default: "3" },
      },
    }));
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  const url = process.env.HH_REAL_GATEWAY_URL;
  const key = process.env.HH_REAL_GATEWAY_KEY;
  const attempts = Number(values.attempts);
  if (!url || !key || !values.model?.length || ![1, 2, 3].includes(attempts)) {
    console.error(
      "usage: HH_REAL_GATEWAY_URL=URL HH_REAL_GATEWAY_KEY=KEY matrix.js --model REF... [--attempts 1-3]",
    );
    return 2;
  }
  let failed = false;
  for (const model of values.model)
    for (const protocol of PROTOCOLS)
      for (const stream of [false, true]) {
        const result = await row(model, protocol, stream, {
          url,
          key,
          attempts,
        });
        failed ||=
          result.text.result === "fail" || result.tool.result === "fail";
        console.log(JSON.stringify(result));
      }
  return failed ? 1 : 0;
}

process.exitCode = await main();
