// SPDX-License-Identifier: MIT
/**
 * The four protocol modules of the fake provider and the interface they share.
 *
 * A request is read into a protocol-neutral view (messages and tools) for the
 * script and the built-in directives; the chosen answer is rendered back in
 * the protocol's own wire format.
 *
 * @typedef {{role: "system" | "user" | "assistant" | "tool", path: string,
 *   text?: string, toolCalls?: {id?: unknown, name?: unknown, arguments?: unknown}[],
 *   echo?: {text?: string, signature?: string}, callId?: unknown}} ViewMessage
 *   One conversation entry; `echo` is the reasoning an assistant message sent
 *   back, `callId` the call a tool result answers.
 * @typedef {{messages: ViewMessage[], tools: {name: unknown, parameters: unknown}[]}} View
 *
 * @typedef {object} Answer What one response says, before wire encoding.
 * @property {string[]} reasoning Reasoning chunks (empty for none).
 * @property {string[]} text Text chunks (empty for none).
 * @property {{id: string | undefined, name: string, arguments: string}[]} toolCalls
 *   `arguments` is the JSON text sent; an id is absent for Gemini.
 * @property {string} finish `stop`, `length`, `tool_calls`, `content_filter`
 *   (mapped to each protocol's value) or any other string, sent verbatim.
 * @property {{input: number, output: number, reasoning: number} | null} usage
 * @property {string} signature Opaque reasoning signature the fake expects back.
 *
 * @typedef {object} Context Per-response values the renderers need.
 * @property {string} id Response id.
 * @property {number} created Unix seconds.
 * @property {string} model
 * @property {Record<string, unknown>} request The parsed request body.
 * @property {boolean} sse Gemini only: `alt=sse`.
 * @property {{duplicateFinish: boolean, missingToolIndex: boolean}} quirks
 *
 * @typedef {object} Protocol
 * @property {string} name
 * @property {(request: import("node:http").IncomingMessage, url: URL) =>
 *   {value: string, via: string} | undefined} credential The key in the
 *   protocol's native place.
 * @property {(kind: "missing" | "invalid") => {status: number, body: unknown}} authFailure
 * @property {(status: number, message: string, extra?: object) => unknown} error
 *   The native error body for a status.
 * @property {(violations: import("./validate.mjs").Violation[]) => {status: number, body: unknown}} invalid
 * @property {(body: Record<string, unknown>, route: Route,
 *   request: import("node:http").IncomingMessage) => import("./validate.mjs").Violation[]} structure
 *   Required fields and shapes the wire format needs.
 * @property {(body: Record<string, unknown>, route: Route) => unknown} model Requested model.
 * @property {(body: Record<string, unknown>, route: Route) => boolean} isStream
 * @property {(body: Record<string, unknown>) => View} read Only called after `structure` passed.
 * @property {() => string | undefined} callId A new tool call id.
 * @property {(body: Record<string, unknown>) => boolean} replayRequired Whether
 *   this request must carry back the reasoning of the calls it answers.
 * @property {(previous: {message: ViewMessage, issued: {name: string, signature: string}}) =>
 *   {status: number, body: unknown}} replayError
 * @property {(body: Record<string, unknown>) => boolean} reasoningShown Whether
 *   an answer to this request shows the reasoning that must come back.
 * @property {(answer: Answer, context: Context) => unknown} render Non-streaming body.
 * @property {(answer: Answer, context: Context) => {contentType: string, frames: string[]}} frames
 *   The streamed body, one frame per write.
 * @property {(context: Context, message: string, written: number) => string} streamError
 *   The frame that reports a failure after `written` frames.
 * @property {(context: Context, streaming: boolean) => string} keepalive A
 *   frame that carries no data (an SSE comment, or JSON whitespace).
 *
 * @typedef {{protocol: string, countTokens?: boolean, model?: string,
 *   stream?: boolean, sse?: boolean}} Route
 */
import { chat } from "./chat.mjs";
import { gemini } from "./gemini.mjs";
import { messages } from "./messages.mjs";
import { responses } from "./responses.mjs";

/** @type {Readonly<Record<string, Protocol>>} */
export const PROTOCOL_MODULES = Object.freeze({
  chat,
  responses,
  messages,
  gemini,
});
