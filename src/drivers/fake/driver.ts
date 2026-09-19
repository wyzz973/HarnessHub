import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import type { Driver, DriverChannel } from "../driver.js";
import type { ExecutionSpec } from "../../domain/ports.js";
import type {
  DriverResult,
  FakeOptions,
  JsonObject,
  PermissionId,
} from "../../domain/types.js";

/** Scenarios reachable from a text directive; `tools` and `tool-only` exist only there. */
type Scenario = FakeOptions["scenario"] | "tools" | "tool-only";

const scenarios: ReadonlySet<string> = new Set<Scenario>([
  "echo",
  "wait",
  "permission",
  "fail",
  "crash",
  "artifact",
  "tools",
  "tool-only",
]);
const directivePattern = /^\[fake:([a-z-]+)\][ \t]*/;

function isScenario(value: string): value is Scenario {
  return scenarios.has(value);
}

/**
 * Reads a leading `[fake:<scenario>]` marker. Ingress APIs that only carry text
 * (for example the Competition API) use it to reach the same deterministic
 * scenarios as `RunInput.fixture`; ordinary text is echoed unchanged.
 */
function parseDirective(
  text: string,
): { scenario: string; text: string } | undefined {
  const match = directivePattern.exec(text);
  if (!match?.[1]) return undefined;
  return { scenario: match[1], text: text.slice(match[0].length) };
}

/** Multi-byte tool result (9000 code points) that exercises consumer truncation. */
const largeToolOutput = "界".repeat(9000);

/**
 * Deterministic external-engine substitute, registered only in explicit demo/test composition.
 *
 * Without `input.fixture`, a text starting with `[fake:<scenario>]` selects a scenario
 * and the remaining text becomes the prompt. `[fake:fail] <message>` fails with that
 * message; `tools` emits three steps with a completed, a failed and a 9000-code-point
 * tool result in the ACP `tool.update` shape plus one thought delta; `tool-only` ends
 * right after a completed tool. An unknown directive fails with `FAKE_DIRECTIVE_INVALID`.
 */
export class FakeDriver implements Driver {
  async execute(
    spec: ExecutionSpec,
    channel: DriverChannel,
    signal: AbortSignal,
  ): Promise<DriverResult> {
    const directive = spec.input.fixture
      ? undefined
      : parseDirective(spec.input.text);
    if (directive && !isScenario(directive.scenario))
      return {
        status: "failed",
        error: {
          code: "FAKE_DIRECTIVE_INVALID",
          message: `Unknown fake directive: ${directive.scenario}`,
        },
      };
    const scenario: Scenario =
      spec.input.fixture?.scenario ??
      (directive && isScenario(directive.scenario)
        ? directive.scenario
        : "echo");
    const text = directive?.text ?? spec.input.text;
    const fixture = spec.input.fixture ?? { scenario: "echo" };
    try {
      signal.throwIfAborted();
      switch (scenario) {
        case "crash":
          process.exit(73);
        case "fail":
          return {
            status: "failed",
            error: {
              code: "FAKE_FAILURE",
              message:
                directive?.text.trim() || "Requested fake engine failure",
            },
          };
        case "wait":
          await channel.emit({
            type: "event",
            event: { type: "fixture.waiting", data: {} },
          });
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else
              signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { status: "cancelled", stopReason: "cancelled" };
        case "permission": {
          const decision = await channel.permission(
            {
              id: randomUUID() as PermissionId,
              toolCallId: "fake-tool",
              prompt: "Allow the fake tool?",
              options: [
                {
                  id: "fake-allow-once",
                  label: "Allow once",
                  kind: "allow_once",
                },
                {
                  id: "fake-reject-once",
                  label: "Reject once",
                  kind: "reject_once",
                },
              ],
            },
            signal,
          );
          if (decision === "fake-reject-once")
            return {
              status: "failed",
              stopReason: "permission_denied",
              error: {
                code: "PERMISSION_DENIED",
                message: "Fake tool permission was denied",
              },
            };
          break;
        }
        case "artifact":
          await channel.emit({
            type: "artifact",
            artifact: {
              name: "result.txt",
              mediaType: "text/plain",
              text,
            },
          });
          break;
        case "tools":
          return await toolSteps(spec, channel, signal, text);
        case "tool-only":
          return await toolOnly(spec, channel, signal);
        case "echo":
          break;
      }
      const chars = Array.from(text);
      const chunkSize = Math.max(
        1,
        Math.ceil(chars.length / (fixture.chunks ?? 1)),
      );
      for (let offset = 0; offset < chars.length; offset += chunkSize) {
        if (fixture.delayMs)
          await setTimeout(fixture.delayMs, undefined, { signal });
        signal.throwIfAborted();
        await delta(channel, spec, chars.slice(offset, offset + chunkSize));
      }
      return {
        status: "completed",
        stopReason: "end_turn",
        output: text,
      };
    } catch (error) {
      if (signal.aborted)
        return { status: "cancelled", stopReason: "cancelled" };
      throw error;
    }
  }
  async close(): Promise<void> {}
}

async function delta(
  channel: DriverChannel,
  spec: ExecutionSpec,
  chars: string[] | string,
  stream: "output" | "thought" = "output",
): Promise<void> {
  await channel.emit({
    type: "event",
    event: {
      type: "message.delta",
      data: {
        text: Array.isArray(chars) ? chars.join("") : chars,
        messageId: spec.runId,
        stream,
      },
    },
  });
}

/** Emits one tool update in the ACP Driver shape (`toolCallId`, summary text and raw details). */
async function tool(
  channel: DriverChannel,
  signal: AbortSignal,
  id: string,
  details: JsonObject,
): Promise<void> {
  signal.throwIfAborted();
  const title = typeof details.title === "string" ? details.title : "tool call";
  const status = typeof details.status === "string" ? details.status : "";
  await channel.emit({
    type: "event",
    event: {
      type: "tool.update",
      data: {
        toolCallId: id,
        text: status ? `${title} (${status})` : title,
        details: {
          type: "tool_call",
          tag: "tool_call_update",
          toolCallId: id,
          ...details,
        },
      },
    },
  });
}

async function toolSteps(
  spec: ExecutionSpec,
  channel: DriverChannel,
  signal: AbortSignal,
  text: string,
): Promise<DriverResult> {
  const output: string[] = [];
  const say = async (
    value: string,
    stream: "output" | "thought" = "output",
  ) => {
    signal.throwIfAborted();
    if (stream === "output") output.push(value);
    await delta(channel, spec, value, stream);
  };
  await say("Inspecting the workspace");
  await say(` for: ${text}`);
  await tool(channel, signal, "call_1", {
    tag: "tool_call",
    status: "pending",
    title: "bash",
    kind: "execute",
    rawInput: {},
  });
  await tool(channel, signal, "call_1", {
    status: "in_progress",
    title: "bash",
    kind: "execute",
    rawInput: { command: "ls", description: "List workspace files" },
  });
  await tool(channel, signal, "call_1", {
    status: "completed",
    title: "List workspace files",
    kind: "execute",
    rawInput: { command: "ls", description: "List workspace files" },
    rawOutput: { output: "README.md\nnotes.txt\n", metadata: { exit: 0 } },
    content: [
      {
        type: "content",
        content: { type: "text", text: "README.md\nnotes.txt\n" },
      },
    ],
  });
  await say("Reading the requested files.");
  await tool(channel, signal, "call_2", {
    tag: "tool_call",
    status: "pending",
    title: "read",
    kind: "read",
    rawInput: { filePath: "missing.txt" },
  });
  await tool(channel, signal, "call_2", {
    status: "failed",
    title: "read",
    kind: "read",
    rawInput: { filePath: "missing.txt" },
    rawOutput: { error: "File not found: missing.txt" },
    content: [
      {
        type: "content",
        content: { type: "text", text: "File not found: missing.txt" },
      },
    ],
  });
  await tool(channel, signal, "call_3", {
    tag: "tool_call",
    status: "in_progress",
    title: "read",
    kind: "read",
    rawInput: { filePath: "large.txt" },
  });
  await tool(channel, signal, "call_3", {
    status: "completed",
    title: "large.txt",
    rawOutput: { output: largeToolOutput },
  });
  await say("Summarizing the tool results", "thought");
  await say(`Done: ${text}`);
  return {
    status: "completed",
    stopReason: "end_turn",
    output: output.join(""),
  };
}

async function toolOnly(
  spec: ExecutionSpec,
  channel: DriverChannel,
  signal: AbortSignal,
): Promise<DriverResult> {
  const reply = "Running the requested command.";
  await delta(channel, spec, reply);
  await tool(channel, signal, "call_1", {
    tag: "tool_call",
    status: "pending",
    title: "bash",
    kind: "execute",
    rawInput: { command: "echo ok" },
  });
  await tool(channel, signal, "call_1", {
    status: "completed",
    title: "Print ok",
    rawOutput: "ok\n",
  });
  return { status: "completed", stopReason: "end_turn", output: reply };
}
