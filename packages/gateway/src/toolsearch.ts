// SPDX-License-Identifier: MIT
/**
 * Tool search for upstreams that cannot run it (Magpie `gw/toolsearch.go`).
 *
 * Codex offers its model a `tool_search` tool (`execution: "client"`) to find
 * the MCP tools it holds back; Codex runs the search itself from the model's
 * `tool_search_call` and sends the result back as a `tool_search_output` with
 * the found tools' definitions. Only ChatGPT's Codex backend knows these, so a
 * Responses request relayed to another upstream gets the search as a plain
 * function `tool_search`, its calls and results as that function's, and the
 * found tools among its tools without `defer_loading`; a call the model makes
 * to it goes back to Codex as the `tool_search_call` Codex runs. Translated
 * requests do the same in ./responses.js.
 *
 * Claude Code's ToolSearch answers with `tool_reference` blocks naming the
 * tools it loaded; a translated upstream reads that each one can be called
 * now (./anthropic.js), and the `DeferredToolPlaceholder` tool, which only
 * keeps Anthropic's deferred loading on, is not offered.
 */
import { createHash } from "node:crypto";
import { record } from "./protocol.js";
import { SseSegmenter } from "./passthrough.js";
import type { OutputTransform } from "./restore.js";

/** The name Codex's tool search is offered to a model under. */
export const TOOL_SEARCH = "tool_search";
/** Claude Code's tool that only keeps deferred loading on; never called. */
export const DEFERRED_TOOL_PLACEHOLDER = "DeferredToolPlaceholder";

type Json = Record<string, unknown>;

/** Whether a Responses tool is Codex's tool search that Codex runs itself. */
export function isClientSearch(tool: Json): boolean {
  return tool.type === TOOL_SEARCH && tool.execution === "client";
}

/** What a model reads for a tool Claude Code's ToolSearch loaded. */
export function toolLoaded(name: string): string {
  return `Tool ${name} is loaded and can be called now.`;
}

/** What a model reads of a tool search's result: the tools it may call now. */
export function searchFound(names: readonly string[]): string {
  return names.length
    ? `These tools are now available to call: ${names.join(", ")}`
    : "No tools matched the search.";
}

/**
 * The names a model is offered the found tools under, by `named`: function
 * and custom tools, and those of a namespace with the namespace.
 */
export function foundNames(
  tools: readonly unknown[],
  named: (name: string, namespace?: string) => string,
): string[] {
  const names: string[] = [];
  for (const value of tools) {
    const tool = record(value);
    if (!tool || typeof tool.name !== "string") continue;
    if (tool.type === "function" || tool.type === "custom")
      names.push(named(tool.name));
    else if (tool.type === "namespace" && Array.isArray(tool.tools))
      for (const nested of tool.tools) {
        const inner = record(nested);
        if (
          typeof inner?.name === "string" &&
          (inner.type === "function" || inner.type === "custom")
        )
          names.push(named(inner.name, tool.name));
      }
  }
  return names;
}

/**
 * A namespaced tool's name as Magpie's relays tell a model of it:
 * `namespace__name`, cut to 64 characters with a hash of both when longer.
 */
export function flatName(name: string, namespace?: string): string {
  if (!namespace) return name;
  const flat = `${namespace}__${name}`;
  if (flat.length <= 64) return flat;
  const sum = createHash("sha256")
    .update(`${namespace}\u0000${name}`)
    .digest("hex")
    .slice(0, 8);
  return `${flat.slice(0, 55)}_${sum}`;
}

/** A found tool without `defer_loading`, nor its namespace's tools. */
function undeferred(tool: Json): Json {
  const copy = { ...tool };
  delete copy.defer_loading;
  if (Array.isArray(copy.tools))
    copy.tools = copy.tools.map((nested) => {
      const inner = record(nested);
      if (!inner) return nested;
      const kept = { ...inner };
      delete kept.defer_loading;
      return kept;
    });
  return copy;
}

function toolKey(tool: Json): string {
  return typeof tool.name === "string" && tool.name
    ? tool.name
    : `#${String(tool.type)}`;
}

/**
 * `tools` with a found tool among them, once; a namespace found again adds
 * the tools it did not have.
 */
function addFound(tools: unknown[], have: Map<string, Json>, tool: Json): void {
  const key = toolKey(tool);
  const old = have.get(key);
  if (!old) {
    have.set(key, tool);
    tools.push(tool);
    return;
  }
  if (old.type !== "namespace" || tool.type !== "namespace") return;
  const nested = Array.isArray(old.tools) ? [...old.tools] : [];
  for (const value of Array.isArray(tool.tools) ? tool.tools : []) {
    const inner = record(value);
    if (inner && !nested.some((known) => record(known)?.name === inner.name))
      nested.push(inner);
  }
  old.tools = nested;
}

/**
 * A Responses request for an upstream other than ChatGPT's Codex backend
 * with Codex's tool search as the plain function {@link TOOL_SEARCH}: its
 * `tool_search_call` items become `function_call` items, its
 * `tool_search_output` items `function_call_output` items saying which tools
 * were found ({@link searchFound}, namespaced ones under {@link flatName}),
 * and the found tools are added to `tools` without `defer_loading`. Item ids
 * are left out, as OpenAI checks their prefix. Undefined when the request
 * offers no such search or is not a JSON object; the body is unchanged then.
 */
export function searchAsFunction(body: Buffer): Buffer | undefined {
  if (!body.includes(`"${TOOL_SEARCH}"`)) return undefined;
  let request: Json | undefined;
  try {
    request = record(JSON.parse(body.toString("utf8")));
  } catch {
    return undefined;
  }
  if (!request || !Array.isArray(request.tools)) return undefined;
  let search = false;
  const tools: unknown[] = request.tools.map((value) => {
    const tool = record(value);
    if (!tool || !isClientSearch(tool)) return value;
    search = true;
    return {
      type: "function",
      name: TOOL_SEARCH,
      ...(tool.description !== undefined
        ? { description: tool.description }
        : {}),
      ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
    };
  });
  if (!search) return undefined;
  const have = new Map<string, Json>();
  for (const value of tools) {
    const tool = record(value);
    if (tool) have.set(toolKey(tool), tool);
  }
  const input = Array.isArray(request.input)
    ? request.input.map((value) => {
        const item = record(value);
        if (item?.type === "tool_search_call")
          return {
            type: "function_call",
            call_id: item.call_id,
            name: TOOL_SEARCH,
            arguments: JSON.stringify(item.arguments ?? {}),
          };
        if (item?.type !== "tool_search_output") return value;
        const found = (Array.isArray(item.tools) ? item.tools : [])
          .map(record)
          .filter((tool): tool is Json => tool !== undefined)
          .map(undeferred);
        for (const tool of found) addFound(tools, have, tool);
        return {
          type: "function_call_output",
          call_id: item.call_id,
          output: searchFound(foundNames(found, flatName)),
        };
      })
    : request.input;
  return Buffer.from(JSON.stringify({ ...request, tools, input }));
}

/**
 * Turns a function call to {@link TOOL_SEARCH} (without a namespace) into the
 * `tool_search_call` Codex runs, in place; true when it was one.
 */
function searchCall(item: Json | undefined): boolean {
  if (
    item?.type !== "function_call" ||
    item.name !== TOOL_SEARCH ||
    (item.namespace !== undefined && item.namespace !== null)
  )
    return false;
  const text = typeof item.arguments === "string" ? item.arguments : "";
  let parsed: unknown;
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  delete item.name;
  item.type = "tool_search_call";
  item.execution = "client";
  item.arguments = record(parsed) ?? {};
  return true;
}

/** Rewrites the search calls of one Responses event or body in place; true when any. */
function searchCalls(value: Json): boolean {
  let changed = searchCall(record(value.item));
  const response = record(value.response) ?? value;
  for (const item of Array.isArray(response.output) ? response.output : [])
    if (searchCall(record(item))) changed = true;
  return changed;
}

/**
 * The model's calls to the {@link TOOL_SEARCH} function in a relayed
 * Responses answer (stream or JSON) as the `tool_search_call` items Codex
 * runs: in `response.output_item.*` events and the response's `output`.
 * Events and bodies without one are written byte for byte; argument deltas
 * of such a call are left as they are.
 */
export class SearchCallRestorer implements OutputTransform {
  #segmenter: SseSegmenter | undefined;
  #body = "";
  #decoder = new TextDecoder();

  constructor(framing: "sse" | "json") {
    // Limits are the writer's own; upstream events are bounded already.
    if (framing === "sse") this.#segmenter = new SseSegmenter(64 * 1024 * 1024);
  }

  push(chunk: string | Uint8Array): string {
    if (!this.#segmenter) {
      this.#body +=
        typeof chunk === "string"
          ? chunk
          : this.#decoder.decode(chunk, { stream: true });
      return "";
    }
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    return this.#segmenter
      .push(bytes)
      .map((segment) => this.#event(segment.text))
      .join("");
  }

  end(): string {
    if (!this.#segmenter) {
      const body = this.#body + this.#decoder.decode();
      this.#body = "";
      if (!body.includes(`"${TOOL_SEARCH}"`)) return body;
      let value: Json | undefined;
      try {
        value = record(JSON.parse(body));
      } catch {
        return body;
      }
      return value && searchCalls(value) ? JSON.stringify(value) : body;
    }
    return this.#segmenter
      .end()
      .map((segment) => this.#event(segment.text))
      .join("");
  }

  #event(raw: string): string {
    if (!raw.includes(`"${TOOL_SEARCH}"`)) return raw;
    const lines = raw.split(/\r\n|\r|\n/);
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (!data.length) return raw;
    let value: Json | undefined;
    try {
      value = record(JSON.parse(data.join("\n")));
    } catch {
      return raw;
    }
    if (!value || !searchCalls(value)) return raw;
    const kept = lines.filter(
      (line) => line !== "" && !line.startsWith("data:"),
    );
    return `${kept.map((line) => `${line}\n`).join("")}data: ${JSON.stringify(value)}\n\n`;
  }
}
