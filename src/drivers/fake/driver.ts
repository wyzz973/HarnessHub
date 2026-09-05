import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import type { Driver, DriverChannel } from "../driver.js";
import type { ExecutionSpec } from "../../domain/ports.js";
import type { DriverResult, PermissionId } from "../../domain/types.js";

/** Deterministic external-engine substitute, registered only in explicit demo/test composition. */
export class FakeDriver implements Driver {
  async execute(
    spec: ExecutionSpec,
    channel: DriverChannel,
    signal: AbortSignal,
  ): Promise<DriverResult> {
    const fixture = spec.input.fixture ?? { scenario: "echo" };
    try {
      signal.throwIfAborted();
      switch (fixture.scenario) {
        case "crash":
          process.exit(73);
        case "fail":
          return {
            status: "failed",
            error: {
              code: "FAKE_FAILURE",
              message: "Requested fake engine failure",
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
              text: spec.input.text,
            },
          });
          break;
        case "echo":
          break;
      }
      const chars = Array.from(spec.input.text);
      const chunkSize = Math.max(
        1,
        Math.ceil(chars.length / (fixture.chunks ?? 1)),
      );
      for (let offset = 0; offset < chars.length; offset += chunkSize) {
        if (fixture.delayMs)
          await setTimeout(fixture.delayMs, undefined, { signal });
        signal.throwIfAborted();
        await channel.emit({
          type: "event",
          event: {
            type: "message.delta",
            data: {
              text: chars.slice(offset, offset + chunkSize).join(""),
              messageId: spec.runId,
              stream: "output",
            },
          },
        });
      }
      return {
        status: "completed",
        stopReason: "end_turn",
        output: spec.input.text,
      };
    } catch (error) {
      if (signal.aborted)
        return { status: "cancelled", stopReason: "cancelled" };
      throw error;
    }
  }
  async close(): Promise<void> {}
}
