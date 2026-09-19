import { isTerminal } from "../../domain/types.js";
import type {
  AgentEvent,
  JsonObject,
  JsonValue,
  PublicError,
  RunId,
  RunRecord,
  TerminalStatus,
} from "../../domain/types.js";

/** Maximum Unicode code points of one tool result copied into a `tool` message. */
export const TOOL_OUTPUT_LIMIT = 8_000;

/** Store-owned terminal lifecycle event names of the public event contract. */
const terminalEvents: Readonly<Record<string, TerminalStatus>> = {
  RUN_COMPLETED: "completed",
  RUN_FAILED: "failed",
  RUN_CANCELLED: "cancelled",
  RUN_TIMED_OUT: "timed_out",
  RUN_INTERRUPTED: "interrupted",
};
const reasoningStreams = new Set(["thought", "reasoning", "analysis"]);

export type ToolStatus = "running" | "completed" | "error";

/** Assistant message part. Ids stay stable between SSE updates and `/message`. */
export type CompetitionPart =
  | { id: string; type: "text"; content: string }
  | {
      id: string;
      type: "tool";
      callID: string;
      tool: string;
      state: { status: ToolStatus; title: string };
    }
  | { id: string; type: "step-finish" };

/** One `message.part.updated` payload: the full current state of one part. */
export interface PartUpdate {
  messageID: string;
  part: CompetitionPart;
}

export interface CompetitionToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

export type CompetitionMessage =
  | { id: string; role: "user"; content: string; created_at: string }
  | {
      id: string;
      role: "assistant";
      content: string;
      tool_calls: CompetitionToolCall[];
      created_at: string;
      info: { role: "assistant"; finish: string; error?: PublicError };
      parts: CompetitionPart[];
    }
  | {
      id: string;
      role: "tool";
      tool_call_id: string;
      tool_name: string;
      content: string;
      created_at: string;
    };

interface ToolState {
  id: string;
  step: number;
  explicitName?: string;
  firstTitle?: string;
  latestTitle?: string;
  kind?: string;
  status: ToolStatus;
  input?: JsonObject;
  output?: string;
  createdAt: number;
  updatedAt: number;
}

interface Step {
  texts: { source: string; content: string }[];
  tools: ToolState[];
  createdAt: number;
}

/** Terminal status of a committed lifecycle event, or undefined for other events. */
export function terminalStatusOf(
  event: AgentEvent,
): TerminalStatus | undefined {
  return Object.hasOwn(terminalEvents, event.type)
    ? terminalEvents[event.type]
    : undefined;
}

/**
 * Public failure of an ended Run: failed, timed-out and interrupted Runs return the
 * recorded error or a status-specific one; completed and cancelled Runs return undefined.
 */
export function failureOf(
  status: TerminalStatus,
  error?: PublicError,
  stopReason?: string,
): PublicError | undefined {
  const reason = stopReason && stopReason !== status ? ` (${stopReason})` : "";
  switch (status) {
    case "completed":
    case "cancelled":
      return undefined;
    case "failed":
      return error ?? { code: "RUN_FAILED", message: `Run failed${reason}` };
    case "timed_out":
      return (
        error ?? { code: "RUN_TIMED_OUT", message: "Run exceeded its deadline" }
      );
    case "interrupted":
      return (
        error ?? {
          code: "RUN_INTERRUPTED",
          message: `Run was interrupted before completion${reason}`,
        }
      );
  }
}

/**
 * Keeps at most `limit` Unicode code points and appends a marker with the omitted
 * count. Surrogate pairs are never split.
 */
export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let total = 0;
  let cut = 0;
  for (const char of text) {
    if (total < limit) cut += char.length;
    total++;
  }
  if (total <= limit) return text;
  return `${text.slice(0, cut)}\n…[truncated ${total - limit} characters]`;
}

/**
 * Folds the committed events of one Run into Competition v1.1 messages.
 *
 * An assistant message is one inferred LLM step: its text, then the tool calls it
 * issued. Output (text or reasoning) that follows a tool call starts the next step,
 * so every earlier step ends with `finish: "tool-calls"`. Each step is followed by
 * `tool` messages for its finished tool calls. An ended Run always finishes with an
 * assistant message that carries the terminal `finish`; when the last step ended in
 * tool calls an empty closing assistant message is added for that purpose.
 * Events must be applied in `seq` order; the instance holds no external resources.
 */
export class RunTranscript {
  private readonly steps: Step[] = [];
  private readonly tools = new Map<string, ToolState>();
  private hasText = false;

  constructor(private readonly runId: RunId) {}

  /** Applies one event and returns the part states it changed, in display order. */
  apply(event: AgentEvent): PartUpdate[] {
    if (event.type === "message.delta") return this.delta(event);
    if (event.type === "tool.update") return this.tool(event);
    const status = terminalStatusOf(event);
    if (!status) return [];
    const output = event.data.output;
    return this.end(typeof output === "string" ? output : undefined);
  }

  /**
   * Renders user, assistant and tool messages. Read `run` before the events that were
   * applied, so a terminal record never pairs with an incomplete event prefix.
   */
  messages(run: RunRecord): CompetitionMessage[] {
    const messages: CompetitionMessage[] = [
      {
        id: `${run.id}:user`,
        role: "user",
        content: run.input.text,
        created_at: iso(run.createdAt),
      },
    ];
    const ended = isTerminal(run.status) ? run.status : undefined;
    const layout = ended ? this.layout(run.output) : undefined;
    const final = ended
      ? finishOf(ended, failureOf(ended, run.error, run.stopReason))
      : undefined;
    this.steps.forEach((step, index) => {
      const last = index === this.steps.length - 1;
      const messageID = this.messageId(index);
      const texts = step.texts.map((text) => text.content);
      if (last && layout?.fallback !== undefined && !layout.closing)
        texts.push(layout.fallback);
      const parts: CompetitionPart[] = [
        ...texts.map((content, part) => textPart(messageID, part + 1, content)),
        ...step.tools.map((tool) => toolPart(messageID, tool)),
      ];
      if (!last || final) parts.push(stepFinish(messageID));
      messages.push({
        id: messageID,
        role: "assistant",
        content: texts.join("\n\n"),
        tool_calls: step.tools.map(toolCall),
        created_at: iso(step.createdAt),
        info: {
          role: "assistant",
          ...(step.tools.length > 0
            ? { finish: "tool-calls" }
            : (final ?? { finish: "running" })),
        },
        parts,
      });
      for (const tool of step.tools)
        if (tool.status !== "running") messages.push(toolMessage(run.id, tool));
    });
    if (final && layout?.closing) {
      const messageID = this.messageId(this.steps.length);
      const content = layout.fallback ?? "";
      messages.push({
        id: messageID,
        role: "assistant",
        content,
        tool_calls: [],
        created_at: iso(run.finishedAt ?? run.createdAt),
        info: { role: "assistant", ...final },
        parts: [
          ...(content ? [textPart(messageID, 1, content)] : []),
          stepFinish(messageID),
        ],
      });
    }
    return messages;
  }

  private messageId(step: number): string {
    return `${this.runId}:assistant:${step + 1}`;
  }

  private open(at: number, updates: PartUpdate[]): number {
    const previous = this.steps.length - 1;
    if (previous >= 0) updates.push(this.finishUpdate(previous));
    this.steps.push({ texts: [], tools: [], createdAt: at });
    return previous + 1;
  }

  private finishUpdate(step: number): PartUpdate {
    const messageID = this.messageId(step);
    return { messageID, part: stepFinish(messageID) };
  }

  private delta(event: AgentEvent): PartUpdate[] {
    const value = typeof event.data.text === "string" ? event.data.text : "";
    if (!value) return [];
    const updates: PartUpdate[] = [];
    let index = this.steps.length - 1;
    let step = this.steps[index];
    if (!step || step.tools.length > 0) {
      index = this.open(event.observedAt, updates);
      step = this.steps[index];
    }
    const stream =
      typeof event.data.stream === "string" ? event.data.stream : "";
    if (!step || reasoningStreams.has(stream)) return updates;
    const source =
      typeof event.data.messageId === "string" ? event.data.messageId : "";
    let segment = step.texts.at(-1);
    if (segment?.source !== source) {
      segment = { source, content: "" };
      step.texts.push(segment);
    }
    segment.content += value;
    this.hasText = true;
    const messageID = this.messageId(index);
    updates.push({
      messageID,
      part: textPart(messageID, step.texts.length, segment.content),
    });
    return updates;
  }

  private tool(event: AgentEvent): PartUpdate[] {
    const details = object(event.data.details) ?? {};
    const id =
      text(event.data.toolCallId) ||
      text(details.toolCallId) ||
      `${event.runId}:${event.seq}`;
    const updates: PartUpdate[] = [];
    let state = this.tools.get(id);
    if (!state) {
      let index = this.steps.length - 1;
      if (index < 0) index = this.open(event.observedAt, updates);
      state = {
        id,
        step: index,
        status: "running",
        createdAt: event.observedAt,
        updatedAt: event.observedAt,
      };
      this.steps[index]?.tools.push(state);
      this.tools.set(id, state);
    }
    const status = toolStatus(text(details.status) || text(event.data.status));
    if (status) state.status = status;
    const title = text(details.title).trim();
    // acpx substitutes "tool call" when an update omits its title.
    if (title && title.toLowerCase() !== "tool call") {
      state.firstTitle ??= title;
      state.latestTitle = title;
    }
    const name = text(details.name).trim();
    if (name) state.explicitName ??= name;
    const kind = text(details.kind).trim();
    if (kind) state.kind ??= kind;
    if (Object.hasOwn(details, "rawInput")) {
      const input = toolInput(details.rawInput);
      if (input && (Object.keys(input).length > 0 || !state.input))
        state.input = input;
    }
    const output =
      contentText(details.content) || outputText(details.rawOutput);
    if (output) state.output = output;
    state.updatedAt = event.observedAt;
    const messageID = this.messageId(state.step);
    updates.push({ messageID, part: toolPart(messageID, state) });
    return updates;
  }

  private layout(output: string | undefined): {
    closing: boolean;
    fallback?: string;
  } {
    const last = this.steps.at(-1);
    return {
      closing: !last || last.tools.length > 0,
      // Drivers that return output without streaming deltas still show a reply.
      ...(!this.hasText && output ? { fallback: output } : {}),
    };
  }

  private end(output: string | undefined): PartUpdate[] {
    const layout = this.layout(output);
    const updates: PartUpdate[] = [];
    const last = this.steps.length - 1;
    const final = layout.closing ? this.steps.length : last;
    if (layout.fallback !== undefined) {
      const messageID = this.messageId(final);
      const part = layout.closing
        ? 1
        : (this.steps[last]?.texts.length ?? 0) + 1;
      updates.push({
        messageID,
        part: textPart(messageID, part, layout.fallback),
      });
    }
    if (last >= 0) updates.push(this.finishUpdate(last));
    if (layout.closing) updates.push(this.finishUpdate(final));
    return updates;
  }
}

function finishOf(
  status: TerminalStatus,
  failure: PublicError | undefined,
): { finish: string; error?: PublicError } {
  if (failure) return { finish: "error", error: failure };
  return { finish: status === "completed" ? "stop" : "cancelled" };
}

function textPart(
  messageID: string,
  index: number,
  content: string,
): CompetitionPart {
  return { id: `${messageID}:text:${index}`, type: "text", content };
}

function stepFinish(messageID: string): CompetitionPart {
  return { id: `${messageID}:step-finish`, type: "step-finish" };
}

function toolName(tool: ToolState): string {
  return tool.explicitName ?? tool.firstTitle ?? tool.kind ?? "tool";
}

function toolPart(messageID: string, tool: ToolState): CompetitionPart {
  return {
    id: `${messageID}:tool:${tool.id}`,
    type: "tool",
    callID: tool.id,
    tool: toolName(tool),
    state: { status: tool.status, title: tool.latestTitle ?? toolName(tool) },
  };
}

function toolCall(tool: ToolState): CompetitionToolCall {
  return { id: tool.id, name: toolName(tool), arguments: tool.input ?? {} };
}

function toolMessage(runId: RunId, tool: ToolState): CompetitionMessage {
  const output =
    tool.output ??
    (tool.status === "error" ? "Tool call failed without output" : "");
  return {
    id: `${runId}:tool:${tool.id}`,
    role: "tool",
    tool_call_id: tool.id,
    tool_name: toolName(tool),
    content: truncateText(output, TOOL_OUTPUT_LIMIT),
    created_at: iso(tool.updatedAt),
  };
}

function toolStatus(value: string): ToolStatus | undefined {
  switch (value.toLowerCase()) {
    case "pending":
    case "in_progress":
    case "running":
      return "running";
    case "completed":
    case "success":
      return "completed";
    case "failed":
    case "error":
      return "error";
    default:
      return undefined;
  }
}

function toolInput(value: JsonValue | undefined): JsonObject | undefined {
  if (value === undefined || value === null) return undefined;
  return object(value) ?? { input: value };
}

function contentText(value: JsonValue | undefined): string {
  if (!Array.isArray(value)) return "";
  const lines: string[] = [];
  for (const entry of value) {
    const item = object(entry);
    if (!item) continue;
    const type = text(item.type);
    if (type === "content") {
      const block = object(item.content);
      const resource = object(block?.resource);
      const line = text(block?.text) || text(resource?.text);
      if (line) lines.push(line);
    } else if (type === "diff") lines.push(`diff ${text(item.path) || "file"}`);
    else if (type === "terminal")
      lines.push(`[terminal ${text(item.terminalId)}]`);
  }
  return lines.join("\n");
}

const outputKeys = [
  "output",
  "stdout",
  "text",
  "content",
  "message",
  "error",
  "stderr",
  "result",
];

function outputText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  const record = object(value);
  if (record)
    for (const key of outputKeys) {
      const candidate = record[key];
      if (typeof candidate === "string") return candidate;
    }
  return JSON.stringify(value);
}

function object(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
