// SPDX-License-Identifier: MIT
/**
 * What the fake provider answers: scripted turns first, then the built-in
 * directives that existing users rely on, then `OK`.
 *
 * Built-in directives, looked up in the user text of the turn being answered:
 *
 * - `HH_MOCK_TOOL`: when the request offers a shell-like tool
 *   (bash/shell/exec/run_shell_command/execute/terminal ... with a `command`/`cmd`
 *   argument), the first round returns one tool call that writes `mock-ok.txt`
 *   in the engine's working directory; the follow-up that carries the tool
 *   result is answered `DONE`. Without a shell-like tool the answer is
 *   `NO_SHELL_TOOL` (or `OK` without any tools). A conversation that re-sends
 *   the same turn more than three times without the tool result gets `DONE`
 *   instead of a new call (`tool-loop-stopped`); the count is kept per
 *   conversation, not per prompt text.
 * - `HH_MOCK_SLOW`: a stream sends `slowMs / 500` dots, every frame 500 ms after
 *   the previous one, until done or the client disconnected; a non-streaming
 *   answer waits `slowMs`.
 * - `HH_MOCK_UNICODE`: a fixed non-ASCII text in two chunks (Chinese, a Latin-1
 *   letter, a BMP symbol and an emoji outside the BMP).
 *
 * A script is JSON, `{"turns": [turn, ...]}`. Each request takes the first
 * unused turn whose `when` matches (a turn with `"repeat": true` is never used
 * up); with none left, the directives apply. A turn has:
 *
 * - `when`: `{"contains": "text"}` matches the user text of the current turn;
 *   `{"toolResult": true|false}` whether the request ends with a tool result;
 *   `{"toolResultContains": "text"}` a request that ends with a tool result
 *   holding the text; `{"offersTool": "name"}` a request that offers a tool
 *   of that name. Every condition given must hold.
 * - `reasoning`, `text`: a string (split into two chunks, text only when longer
 *   than 8 code points) or an array of chunks sent as given.
 * - `toolCalls`: `[{"name", "arguments": object or raw JSON text, "id"?}]`.
 * - `finish`: `stop`, `length`, `tool_calls`, `content_filter`, or any string
 *   sent verbatim; default `tool_calls` with calls, otherwise `stop`.
 * - `usage`: `{"input", "output", "reasoning"?}` token counts, or `false` for none.
 * - `status` (400–599) with an optional `error` message: an error response in
 *   the protocol's envelope instead of an answer.
 * - `firstByteDelayMs`: wait before the first body byte; streams send their
 *   headers first, a non-streaming answer sends headers and body after it.
 * - `chunkDelayMs`: wait between stream frames (default: the provider's).
 * - `quirks`: quirk switches for this turn (see quirks.mjs).
 */
import { createHash } from "node:crypto";
import {
  canonicalArguments,
  estimateTokens,
  halves,
  hex,
  isObject,
} from "./common.mjs";
import { resolveQuirks } from "./quirks.mjs";

export const DIRECTIVES = Object.freeze({
  tool: "HH_MOCK_TOOL",
  slow: "HH_MOCK_SLOW",
  unicode: "HH_MOCK_UNICODE",
});
export const REPLIES = Object.freeze({
  ok: "OK",
  done: "DONE",
  noShellTool: "NO_SHELL_TOOL",
  unicode: "中文回复：完成 ✅ café 🎉",
});
export const MARKER_FILE = "mock-ok.txt";
export const MARKER_TEXT = "mock-ok";

const MAX_MS = 2 ** 31 - 1;
const SLOW_TICK_MS = 500;

const preferredShellTools = [
  "bash",
  "shell",
  "run_shell_command",
  "shell_command",
  "exec_command",
  "exec",
  "execute",
  "terminal",
  "powershell",
  "run_command",
  "execute_command",
  "run_terminal_cmd",
];
const shellName =
  /(bash|shell|exec|execute|terminal|command|powershell|pwsh|cmd)/i;
const notShellName =
  /(code|python|file|read|write|edit|search|grep|glob|web|fetch|browser|todo|task|agent|mcp|notebook|kill|output|status|stdin|process|background|list|view|patch|image)/i;
const commandKeys = ["command", "cmd", "script", "commandLine", "command_line"];

/**
 * The JSON type a schema names, in lower case: Gemini function declarations
 * spell the OpenAPI types in upper case (`STRING`, `OBJECT`).
 */
function schemaType(schema) {
  if (!isObject(schema)) return undefined;
  if (typeof schema.type === "string") return schema.type.toLowerCase();
  if (Array.isArray(schema.type))
    return schema.type
      .find((type) => typeof type === "string" && type.toLowerCase() !== "null")
      ?.toLowerCase();
  for (const key of ["anyOf", "oneOf"])
    if (Array.isArray(schema[key]))
      for (const option of schema[key]) {
        const type = schemaType(option);
        if (type && type !== "null") return type;
      }
  return undefined;
}

/**
 * The shell-like function tool `HH_MOCK_TOOL` drives, or undefined when none exists.
 * @param {import("./protocols.mjs").View["tools"]} tools
 */
export function selectShellTool(tools) {
  const candidates = [];
  for (const tool of tools) {
    const name = tool.name;
    if (
      typeof name !== "string" ||
      !shellName.test(name) ||
      notShellName.test(name)
    )
      continue;
    const parameters = isObject(tool.parameters) ? tool.parameters : {};
    const properties = isObject(parameters.properties)
      ? parameters.properties
      : {};
    const key = commandKeys.find((candidate) =>
      Object.hasOwn(properties, candidate),
    );
    if (!key) continue;
    const kind = schemaType(properties[key]) ?? "string";
    if (kind !== "string" && kind !== "array") continue;
    const rank = preferredShellTools.indexOf(name.toLowerCase());
    candidates.push({
      name,
      key,
      kind,
      parameters,
      rank: rank < 0 ? preferredShellTools.length : rank,
    });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return candidates[0];
}

function defaultArgument(name, schema) {
  if (isObject(schema) && Array.isArray(schema.enum) && schema.enum.length)
    return schema.enum[0];
  switch (schemaType(schema)) {
    case "integer":
    case "number":
      return /timeout/i.test(name) ? (/ms|milli/i.test(name) ? 60000 : 60) : 1;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      if (/dir|cwd|path|folder/i.test(name)) return ".";
      return "Create the HarnessHub mock marker file";
  }
}

/**
 * Tool arguments that create the marker file in the tool's working directory.
 * `echo mock-ok > mock-ok.txt` has the same effect in bash, cmd.exe and PowerShell.
 */
export function markerArguments(selection, platform = process.platform) {
  const command = `echo ${MARKER_TEXT} > ${MARKER_FILE}`;
  const value =
    selection.kind === "array"
      ? platform === "win32"
        ? ["cmd.exe", "/d", "/c", `echo ${MARKER_TEXT}> ${MARKER_FILE}`]
        : ["sh", "-c", command]
      : command;
  const result = { [selection.key]: value };
  const properties = isObject(selection.parameters.properties)
    ? selection.parameters.properties
    : {};
  const required = Array.isArray(selection.parameters.required)
    ? selection.parameters.required
    : [];
  for (const name of required)
    if (typeof name === "string" && !Object.hasOwn(result, name))
      result[name] = defaultArgument(name, properties[name]);
  return result;
}

/** Index of the first message of the turn being answered (after the last plain reply). */
function currentTurnStart(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "assistant" && !message.toolCalls?.length)
      return index + 1;
  }
  return 0;
}

/** Text of the user messages that belong to the turn being answered. */
export function currentTurnText(messages) {
  return messages
    .slice(currentTurnStart(messages))
    .filter((message) => message.role === "user")
    .map((message) => message.text)
    .join("\n");
}

/**
 * Identity of the turn being answered within its conversation: every earlier
 * message plus the system and user messages of the current turn. Tool-call
 * rounds of the current turn are left out, so re-sending the same turn keeps
 * the key, while another engine or conversation with the same prompt differs
 * in its system prompt or history. Identical conversations cannot be told
 * apart; callers that repeat one add a nonce.
 */
export function conversationTurnKey(messages) {
  const start = currentTurnStart(messages);
  const hash = createHash("sha256");
  messages.forEach((message, index) => {
    if (index >= start && message.role !== "system" && message.role !== "user")
      return;
    hash.update(JSON.stringify([message.role, message.text ?? ""]));
  });
  return hash.digest("hex");
}

/**
 * The last assistant tool call of the request that this provider issued, and
 * whether a tool result follows it. Calls match by id, or by name and
 * canonical arguments (Gemini has no call ids, and a translating client may
 * replace them); among several issued calls with the same name and arguments
 * the latest whose reasoning the message carries back wins, otherwise the latest.
 *
 * @param {import("./protocols.mjs").ViewMessage[]} messages
 * @param {Map<string, {name: string, arguments: string}>} issued
 */
export function findIssuedCall(messages, issued) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    for (const call of message.toolCalls) {
      let known = typeof call.id === "string" ? issued.get(call.id) : undefined;
      if (!known) {
        const candidates = [...issued.values()].filter(
          (candidate) =>
            candidate.name === call.name &&
            candidate.arguments === canonicalArguments(call.arguments),
        );
        known =
          candidates.findLast(
            (candidate) => echoStatus(message.echo, candidate) === true,
          ) ?? candidates.at(-1);
      }
      if (known)
        return {
          message,
          issued: known,
          answered: messages
            .slice(index + 1)
            .some((next) => next.role === "tool"),
        };
    }
    return undefined;
  }
  return undefined;
}

/**
 * Whether the reasoning an assistant message sent back is the issued one:
 * `false` when absent, `true` when its signature or text matches, otherwise
 * `"mismatch"`.
 */
export function echoStatus(echo, issued) {
  const text = echo?.text?.trim() ?? "";
  if (!text && !echo?.signature) return false;
  return echo.signature === issued.signature ||
    (text !== "" && text === issued.reasoning.trim())
    ? true
    : "mismatch";
}

function chunks(value, split) {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return split(value);
}

const textChunks = (text) =>
  Array.from(text).length > 8 ? halves(text) : text ? [text] : [];
const reasoningChunks = (text) => halves(text);

/**
 * Build an answer. Strings are split like the built-in replies; usage is
 * estimated unless given (`false` for none).
 *
 * @returns {import("./protocols.mjs").Answer}
 */
export function buildAnswer(
  { reasoning, text, toolCalls = [], finish, usage },
  inputTokens,
) {
  const answer = {
    reasoning: chunks(reasoning, reasoningChunks),
    text: chunks(text, textChunks),
    toolCalls,
    finish: finish ?? (toolCalls.length ? "tool_calls" : "stop"),
    signature: hex(24),
  };
  const reasoningChars = answer.reasoning.join("").length;
  const reasoningTokens = reasoningChars ? estimateTokens(reasoningChars) : 0;
  const visibleChars =
    answer.text.join("").length +
    toolCalls.reduce((total, call) => total + call.arguments.length, 0);
  answer.usage =
    usage === false
      ? null
      : usage !== undefined
        ? {
            input: usage.input,
            output: usage.output,
            reasoning: usage.reasoning ?? 0,
          }
        : {
            input: inputTokens,
            output:
              reasoningTokens +
                (visibleChars ? estimateTokens(visibleChars) : 0) || 1,
            reasoning: reasoningTokens,
          };
  return answer;
}

function chunkList(value, where) {
  if (typeof value === "string") return value;
  if (
    Array.isArray(value) &&
    value.length &&
    value.every((chunk) => typeof chunk === "string")
  )
    return Object.freeze([...value]);
  throw new Error(`${where} must be a string or a non-empty array of strings`);
}

function delay(value, where) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_MS)
    throw new Error(`${where} must be an integer from 0 to ${MAX_MS}`);
  return value;
}

const TURN_KEYS = [
  "when",
  "repeat",
  "reasoning",
  "text",
  "toolCalls",
  "finish",
  "usage",
  "status",
  "error",
  "firstByteDelayMs",
  "chunkDelayMs",
  "quirks",
];

/**
 * Validate a script.
 *
 * @param {unknown} value Parsed JSON, `{"turns": [...]}`.
 * @returns {Readonly<{turns: readonly object[]}>}
 * @throws {Error} Naming the first invalid setting, such as `turns[2].toolCalls[0].name`.
 */
export function parseScript(value) {
  if (!isObject(value) || Object.keys(value).some((key) => key !== "turns"))
    throw new Error('A script must be an object with only "turns"');
  if (!Array.isArray(value.turns))
    throw new Error("script.turns must be an array");
  const turns = value.turns.map((turn, index) => {
    const at = `turns[${index}]`;
    if (!isObject(turn)) throw new Error(`${at} must be an object`);
    for (const key of Object.keys(turn))
      if (!TURN_KEYS.includes(key))
        throw new Error(`${at}.${key} is not a known turn setting`);
    const result = {};
    if (turn.when !== undefined) {
      const conditions = [
        "contains",
        "toolResult",
        "toolResultContains",
        "offersTool",
      ];
      if (
        !isObject(turn.when) ||
        Object.keys(turn.when).some((key) => !conditions.includes(key))
      )
        throw new Error(
          `${at}.when must be an object with ${conditions.join(", ")}`,
        );
      for (const key of ["contains", "toolResultContains", "offersTool"])
        if (
          turn.when[key] !== undefined &&
          (typeof turn.when[key] !== "string" || !turn.when[key])
        )
          throw new Error(`${at}.when.${key} must be a non-empty string`);
      if (
        turn.when.toolResult !== undefined &&
        typeof turn.when.toolResult !== "boolean"
      )
        throw new Error(`${at}.when.toolResult must be true or false`);
      result.when = Object.freeze({ ...turn.when });
    }
    if (turn.repeat !== undefined) {
      if (typeof turn.repeat !== "boolean")
        throw new Error(`${at}.repeat must be true or false`);
      result.repeat = turn.repeat;
    }
    if (turn.reasoning !== undefined)
      result.reasoning = chunkList(turn.reasoning, `${at}.reasoning`);
    if (turn.text !== undefined)
      result.text = chunkList(turn.text, `${at}.text`);
    if (turn.toolCalls !== undefined) {
      if (!Array.isArray(turn.toolCalls) || !turn.toolCalls.length)
        throw new Error(`${at}.toolCalls must be a non-empty array`);
      result.toolCalls = Object.freeze(
        turn.toolCalls.map((call, callIndex) => {
          const where = `${at}.toolCalls[${callIndex}]`;
          if (!isObject(call)) throw new Error(`${where} must be an object`);
          for (const key of Object.keys(call))
            if (!["name", "arguments", "id"].includes(key))
              throw new Error(
                `${where}.${key} is not a known tool call setting`,
              );
          if (typeof call.name !== "string" || !call.name)
            throw new Error(`${where}.name must be a non-empty string`);
          if (
            call.id !== undefined &&
            (typeof call.id !== "string" || !call.id)
          )
            throw new Error(`${where}.id must be a non-empty string`);
          const args = call.arguments ?? {};
          if (typeof args !== "string" && !isObject(args))
            throw new Error(
              `${where}.arguments must be an object or JSON text`,
            );
          return Object.freeze({
            name: call.name,
            arguments: typeof args === "string" ? args : JSON.stringify(args),
            ...(call.id ? { id: call.id } : {}),
          });
        }),
      );
    }
    if (turn.finish !== undefined) {
      if (typeof turn.finish !== "string" || !turn.finish)
        throw new Error(`${at}.finish must be a non-empty string`);
      result.finish = turn.finish;
    }
    if (turn.usage !== undefined) {
      if (turn.usage === false) result.usage = false;
      else if (
        isObject(turn.usage) &&
        Object.keys(turn.usage).every((key) =>
          ["input", "output", "reasoning"].includes(key),
        ) &&
        [turn.usage.input, turn.usage.output, turn.usage.reasoning ?? 0].every(
          (count) => Number.isInteger(count) && count >= 0,
        )
      )
        result.usage = Object.freeze({ ...turn.usage });
      else
        throw new Error(
          `${at}.usage must be false or {input, output, reasoning?} token counts`,
        );
    }
    if (turn.status !== undefined) {
      if (
        !Number.isInteger(turn.status) ||
        turn.status < 400 ||
        turn.status > 599
      )
        throw new Error(`${at}.status must be an HTTP error status (400-599)`);
      if (
        result.reasoning !== undefined ||
        result.text !== undefined ||
        result.toolCalls !== undefined
      )
        throw new Error(`${at} cannot have a status and an answer`);
      result.status = turn.status;
      result.error = "Scripted upstream error";
    }
    if (turn.error !== undefined) {
      if (result.status === undefined)
        throw new Error(`${at}.error needs a status`);
      if (typeof turn.error !== "string" || !turn.error)
        throw new Error(`${at}.error must be a non-empty string`);
      result.error = turn.error;
    }
    if (turn.firstByteDelayMs !== undefined)
      result.firstByteDelayMs = delay(
        turn.firstByteDelayMs,
        `${at}.firstByteDelayMs`,
      );
    if (turn.chunkDelayMs !== undefined)
      result.chunkDelayMs = delay(turn.chunkDelayMs, `${at}.chunkDelayMs`);
    if (turn.quirks !== undefined)
      result.quirks = resolveQuirks(turn.quirks, `${at}.quirks`);
    return Object.freeze(result);
  });
  return Object.freeze({ turns: Object.freeze(turns) });
}

/**
 * Mutable answering state of one provider: script turns used, calls issued
 * and the tool-loop counter.
 */
export function createState(script) {
  return {
    script,
    used: new Set(),
    /** @type {Map<string, {name: string, arguments: string, reasoning: string, signature: string, reasoningSent: boolean}>} */
    issued: new Map(),
    issuesPerTurn: new Map(),
  };
}

function pickTurn(state, view) {
  const turns = state.script?.turns ?? [];
  const text = currentTurnText(view.messages);
  const last = view.messages.at(-1);
  const toolResult = last?.role === "tool";
  const index = turns.findIndex(
    (turn, position) =>
      !state.used.has(position) &&
      (turn.when?.contains === undefined ||
        text.includes(turn.when.contains)) &&
      (turn.when?.toolResult === undefined ||
        turn.when.toolResult === toolResult) &&
      (turn.when?.toolResultContains === undefined ||
        (toolResult &&
          (last.text ?? "").includes(turn.when.toolResultContains))) &&
      (turn.when?.offersTool === undefined ||
        view.tools.some((tool) => tool.name === turn.when.offersTool)),
  );
  if (index < 0) return undefined;
  if (!turns[index].repeat) state.used.add(index);
  return { index, turn: turns[index] };
}

/**
 * Decide the answer to one request.
 *
 * @param {import("./protocols.mjs").View} view
 * @param {ReturnType<typeof createState>} state Updated: script turns, tool loop counts.
 * @param {{protocol: import("./protocols.mjs").Protocol, streaming: boolean,
 *   inputTokens: number, slowMs: number, platform: string}} settings
 * @returns {{turn: string, script?: number, answer?: import("./protocols.mjs").Answer,
 *   error?: {status: number, message: string}, firstByteDelayMs?: number,
 *   chunkDelayMs?: number, quirks?: object, tool?: string, toolNames?: string[]}}
 *   `turn` labels the request record.
 */
export function planTurn(view, state, settings) {
  const { protocol, inputTokens } = settings;
  const picked = pickTurn(state, view);
  if (picked) {
    const { turn, index } = picked;
    const timing = {
      ...(turn.firstByteDelayMs !== undefined
        ? { firstByteDelayMs: turn.firstByteDelayMs }
        : {}),
      ...(turn.chunkDelayMs !== undefined
        ? { chunkDelayMs: turn.chunkDelayMs }
        : {}),
      ...(turn.quirks ? { quirks: turn.quirks } : {}),
    };
    if (turn.status !== undefined)
      return {
        turn: "script",
        script: index,
        error: { status: turn.status, message: turn.error },
        ...timing,
      };
    const toolCalls = (turn.toolCalls ?? []).map((call) => ({
      id: call.id ?? protocol.callId(),
      name: call.name,
      arguments: call.arguments,
    }));
    const answer = buildAnswer(
      {
        reasoning: turn.reasoning,
        text:
          turn.text ??
          (toolCalls.length || turn.reasoning !== undefined
            ? undefined
            : REPLIES.ok),
        toolCalls,
        finish: turn.finish,
        usage: turn.usage,
      },
      inputTokens,
    );
    return { turn: "script", script: index, answer, ...timing };
  }

  const reply = (text, reasoning, turn, extra = {}) => ({
    turn,
    answer: buildAnswer({ text, reasoning }, inputTokens),
    ...extra,
  });
  const text = currentTurnText(view.messages);
  if (text.includes(DIRECTIVES.slow)) {
    const ticks = Math.max(1, Math.floor(settings.slowMs / SLOW_TICK_MS));
    const answer = buildAnswer(
      {
        reasoning: ["Long task requested; streaming slowly."],
        text: [...Array(ticks).fill("."), ` ${REPLIES.done}`],
      },
      inputTokens,
    );
    return settings.streaming
      ? { turn: "slow", answer, chunkDelayMs: SLOW_TICK_MS }
      : { turn: "slow", answer, firstByteDelayMs: settings.slowMs };
  }
  if (text.includes(DIRECTIVES.unicode))
    return reply(
      REPLIES.unicode,
      "The instruction asks for the fixed non-ASCII line.",
      "unicode",
    );
  if (text.includes(DIRECTIVES.tool)) {
    const previous = findIssuedCall(view.messages, state.issued);
    if (previous?.answered)
      return reply(
        REPLIES.done,
        "The marker command finished; reporting completion.",
        "tool-result",
        {
          tool: previous.issued.name,
        },
      );
    const selection = selectShellTool(view.tools);
    if (!selection) {
      const offered = view.tools.length > 0;
      return reply(
        offered ? REPLIES.noShellTool : REPLIES.ok,
        "No shell-like tool is available for the marker command.",
        offered ? "no-shell-tool" : "no-tools",
        {
          toolNames: view.tools
            .map((tool) => tool.name)
            .filter((name) => typeof name === "string")
            .slice(0, 40),
        },
      );
    }
    // Loop protection is per conversation, so engines sharing one provider and
    // one prompt each get their own tool call.
    const turnKey = conversationTurnKey(view.messages);
    const attempts = (state.issuesPerTurn.get(turnKey) ?? 0) + 1;
    state.issuesPerTurn.set(turnKey, attempts);
    if (attempts > 3)
      return reply(
        REPLIES.done,
        "Tool call was not answered; stopping.",
        "tool-loop-stopped",
      );
    const id = protocol.callId();
    const answer = buildAnswer(
      {
        reasoning: [
          `Need to run ${selection.name} once to create ${MARKER_FILE}${id ? `; call ${id}` : ""}.`,
        ],
        toolCalls: [
          {
            id,
            name: selection.name,
            arguments: JSON.stringify(
              markerArguments(selection, settings.platform),
            ),
          },
        ],
      },
      inputTokens,
    );
    return { turn: "tool-call", answer, tool: selection.name };
  }
  return reply(
    REPLIES.ok,
    "The instruction asks for a short acknowledgement.",
    "plain",
  );
}
