import { randomUUID } from "node:crypto";
import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
} from "acpx/runtime";
import type {
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpRuntime,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
} from "acpx/runtime";
import type { Driver, DriverChannel } from "../driver.js";
import type { ExecutionSpec } from "../../domain/ports.js";
import type {
  DriverResult,
  JsonObject,
  JsonValue,
  PermissionId,
  PermissionOption,
} from "../../domain/types.js";

/** ACP types terminate here. Credentials are inherited only through the Worker environment. */
export class AcpDriver implements Driver {
  private runtime: AcpRuntime | undefined;
  private handle: AcpRuntimeHandle | undefined;
  private current: { channel: DriverChannel; signal: AbortSignal } | undefined;

  async execute(
    spec: ExecutionSpec,
    channel: DriverChannel,
    signal: AbortSignal,
  ): Promise<DriverResult> {
    if (spec.input.fixture)
      throw new Error("Fake fixtures are not accepted by ACP engines");
    if (!spec.profile.command?.length)
      throw new Error("ACP profile requires a fixed command argv");
    this.current = { channel, signal };
    try {
      if (!this.runtime) {
        this.runtime = createAcpRuntime({
          cwd: spec.cwd,
          sessionStore: createFileSessionStore({ stateDir: spec.stateDir }),
          agentRegistry: createAgentRegistry({
            overrides: { [spec.profile.id]: spec.profile.command },
          }),
          permissionMode: "deny-all",
          nonInteractivePermissions: "deny",
          timeoutMs: 0,
          onPermissionRequest: (request, context) =>
            this.permission(request, context.signal),
        });
      }
      signal.throwIfAborted();
      this.handle ??= await this.runtime.ensureSession({
        sessionKey: spec.sessionId,
        agent: spec.profile.id,
        mode: "persistent",
        cwd: spec.cwd,
        ...(spec.profile.model
          ? { sessionOptions: { model: spec.profile.model } }
          : {}),
      });
      signal.throwIfAborted();
      const capabilities = await this.runtime.getCapabilities?.({
        handle: this.handle,
      });
      const status = await this.runtime.getStatus?.({ handle: this.handle });
      await channel.emit({
        type: "event",
        event: {
          type: "engine.capabilities",
          data: {
            controls: capabilities?.controls ?? [],
            configOptionKeys: capabilities?.configOptionKeys ?? [],
            models: status?.models ? json(status.models) : null,
          },
        },
      });
      const turn = this.runtime.startTurn({
        handle: this.handle,
        text: spec.input.text,
        mode: "prompt",
        requestId: `${spec.runId}:${spec.generation}`,
        timeoutMs: 0,
        signal,
      });
      // Result is independently owned even when event delivery fails or a consumer disconnects.
      void turn.result.catch(() => undefined);
      const output: string[] = [];
      try {
        for await (const event of turn.events) {
          if (event.type === "text_delta" && event.stream !== "thought")
            output.push(event.text);
          await channel.emit({
            type: "event",
            event: mapEvent(event, spec.runId),
          });
        }
        const result = await turn.result;
        switch (result.status) {
          case "completed":
            return {
              status: "completed",
              ...(result.stopReason ? { stopReason: result.stopReason } : {}),
              output: output.join(""),
            };
          case "cancelled":
            return {
              status: "cancelled",
              stopReason: result.stopReason ?? "cancelled",
              output: output.join(""),
            };
          case "failed":
            return {
              status: "failed",
              error: {
                code: "ACP_TURN_FAILED",
                message: "ACP engine reported execution failure",
              },
              output: output.join(""),
            };
        }
      } catch (error) {
        await turn.cancel({ reason: "driver_delivery_failed" });
        await turn.result;
        throw error;
      }
    } finally {
      this.current = undefined;
    }
  }

  private async permission(
    request: AcpPermissionRequest,
    callbackSignal: AbortSignal,
  ): Promise<AcpPermissionDecision> {
    const current = this.current;
    if (!current || current.signal.aborted || callbackSignal.aborted)
      return { outcome: "cancel" };
    const options: PermissionOption[] = [];
    for (const raw of request.raw.options) {
      if (raw.kind === "allow_once" || raw.kind === "reject_once")
        options.push({ id: raw.optionId, label: raw.name, kind: raw.kind });
    }
    // acpx accepts a kind, not optionId. Ambiguous kinds cannot preserve an exact user's choice.
    if (
      !options.length ||
      new Set(options.map((option) => option.kind)).size !== options.length
    ) {
      await current.channel.emit({
        type: "event",
        event: {
          type: "permission.unsupported",
          data: {
            reason: "ACP runtime cannot select these exact option IDs",
            toolCallId: request.raw.toolCall.toolCallId,
          },
        },
      });
      return { outcome: "cancel" };
    }
    const signal = AbortSignal.any([current.signal, callbackSignal]);
    try {
      const optionId = await current.channel.permission(
        {
          id: randomUUID() as PermissionId,
          toolCallId: request.raw.toolCall.toolCallId,
          prompt: request.raw.toolCall.title ?? "Agent requests permission",
          options,
        },
        signal,
      );
      const selected = options.find((option) => option.id === optionId);
      if (!selected || signal.aborted) return { outcome: "cancel" };
      return { outcome: selected.kind };
    } catch (error) {
      if (signal.aborted) return { outcome: "cancel" };
      throw error; // deny-all remains the acpx callback failure policy.
    }
  }

  async close(): Promise<void> {
    if (this.runtime && this.handle)
      await this.runtime.close({
        handle: this.handle,
        reason: "session_closed",
      });
    this.handle = undefined;
    this.runtime = undefined;
  }
}

function json(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(json);
  if (typeof value === "object" && value !== null) {
    const output: JsonObject = {};
    for (const [key, item] of Object.entries(value))
      if (item !== undefined) output[key] = json(item);
    return output;
  }
  throw new Error("ACP event contains non-JSON data");
}

function mapEvent(
  event: AcpRuntimeEvent,
  runId: string,
): { type: string; data: JsonObject } {
  switch (event.type) {
    case "text_delta":
      return {
        type: "message.delta",
        data: {
          text: event.text,
          messageId: event.messageId ?? runId,
          stream: event.stream ?? "output",
        },
      };
    case "tool_call":
      return {
        type: "tool.update",
        data: {
          toolCallId: event.toolCallId ?? runId,
          text: event.text,
          details: json(event),
        },
      };
    case "status":
      return {
        type: "engine.status",
        data: { text: event.text, details: json(event) },
      };
    case "done":
      throw new Error("Unexpected compatibility terminal event from startTurn");
    case "error":
      return {
        type: "engine.error",
        data: {
          code: "ACP_EVENT_ERROR",
          message: "ACP engine emitted an error",
        },
      };
  }
}
