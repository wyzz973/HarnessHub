import type { RuntimeMcpServer } from "../configuration/prepare.js";
import { randomUUID } from "node:crypto";
import {
  createAcpRuntime,
  createAgentRegistry,
  isRequestedModelUnsupportedError,
} from "acpx/runtime";
import type {
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpRuntime,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpSessionStore,
} from "acpx/runtime";
import {
  AcpSessionRecoveryError,
  openPinnedSessionStore,
} from "./session-store.js";
import type { Driver, DriverChannel } from "../driver.js";
import {
  acpUsageObservation,
  captureNativeUsage,
  nativeUsageObservation,
} from "./observations.js";
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
  private mcpServers: RuntimeMcpServer[] = [];
  private nativeModelSelection = false;
  /** Native provider configuration can own model selection when ACP advertises no model control. */
  configureNativeModelSelection(enabled: boolean): void {
    if (!this.runtime) this.nativeModelSelection = enabled;
  }
  /** Worker supplies resolved server credentials in memory before the first connection. */
  configureMcp(servers: RuntimeMcpServer[]): void {
    if (!this.runtime) this.mcpServers = servers;
  }
  private handle: AcpRuntimeHandle | undefined;
  private store: AcpSessionStore | undefined;
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
    const recovering = !this.runtime && spec.backendSessionId !== undefined;
    try {
      if (!this.runtime) {
        if (recovering && spec.profile.acp?.sessionMode !== "resume")
          return recoveryUnsupported();
        this.store = await openPinnedSessionStore(spec);
        this.runtime = createAcpRuntime({
          cwd: spec.cwd,
          mcpServers: this.mcpServers,
          sessionStore: this.store,
          agentRegistry: createAgentRegistry({
            overrides: { [spec.profile.id]: spec.profile.command },
          }),
          permissionMode: "deny-all",
          fs: false,
          terminal: false,
          nonInteractivePermissions: "deny",
          timeoutMs: 0,
          onPermissionRequest: (request, context) =>
            this.permission(request, context.signal),
        });
      }
      signal.throwIfAborted();
      const firstConnection = !this.handle;
      this.handle ??= await this.runtime.ensureSession({
        sessionKey: spec.sessionId,
        agent: spec.profile.id,
        mode: "persistent",
        cwd: spec.cwd,
        ...(spec.backendSessionId
          ? { resumeSessionId: spec.backendSessionId }
          : {}),
        ...(spec.profile.model && !this.nativeModelSelection
          ? { sessionOptions: { model: spec.profile.model } }
          : {}),
      });
      if (
        !this.handle.backendSessionId ||
        (spec.backendSessionId !== undefined &&
          this.handle.backendSessionId !== spec.backendSessionId)
      )
        throw new AcpSessionRecoveryError();
      const checkpoint = await this.store?.load(spec.sessionId);
      const advertisedResume =
        checkpoint?.agentCapabilities?.loadSession === true ||
        checkpoint?.agentCapabilities?.sessionCapabilities?.resume != null;
      if (spec.profile.acp?.sessionMode === "resume" && !advertisedResume)
        return recoveryUnsupported();
      if (firstConnection && !recovering)
        await channel.emit({
          type: "event",
          event: {
            type: "engine.session",
            data: {
              backendSessionId: this.handle.backendSessionId,
              resumed: false,
            },
          },
        });
      signal.throwIfAborted();
      const capabilities = await this.runtime.getCapabilities?.({
        handle: this.handle,
      });
      const status = await this.runtime.getStatus?.({ handle: this.handle });
      const emitCapabilities = () =>
        channel.emit({
          type: "event",
          event: {
            type: "engine.capabilities",
            data: {
              controls: capabilities?.controls ?? [],
              configOptionKeys: capabilities?.configOptionKeys ?? [],
              models: status?.models ? json(status.models) : null,
              resumeAdvertised: advertisedResume,
            },
          },
        });
      // A recovered handle can be satisfied by its checkpoint without a live
      // connection. Keep the host's initialization budget armed until reconnect
      // and resume have completed, as confirmed by promptStarted below.
      if (!recovering) await emitCapabilities();
      const observationIdentity = {
        backendSessionId: this.handle.backendSessionId,
        requestId: `${spec.runId}:${spec.generation}`,
        freshSession: firstConnection && !recovering,
      };
      const nativeBefore = await captureNativeUsage(
        spec,
        this.handle.backendSessionId,
      );
      signal.throwIfAborted();
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
      void turn.promptStarted.catch(() => undefined);
      const output: string[] = [];
      try {
        if (recovering) {
          try {
            // ensureSession can reuse a file without connecting. This promise proves
            // persistent same-session reconnect succeeded before prompt submission.
            await turn.promptStarted;
          } catch {
            const result = await turn.result;
            if (signal.aborted || result.status === "cancelled")
              return { status: "cancelled", stopReason: "cancelled" };
            throw new AcpSessionRecoveryError();
          }
          await emitCapabilities();
          await channel.emit({
            type: "event",
            event: {
              type: "engine.session",
              data: {
                backendSessionId: this.handle.backendSessionId,
                resumed: true,
              },
            },
          });
        }
        for await (const event of turn.events) {
          if (event.type === "text_delta" && event.stream !== "thought")
            output.push(event.text);
          await channel.emit({
            type: "event",
            event: mapEvent(event, spec.runId),
          });
        }
        const result = await turn.result;
        const finalStatus = await this.runtime.getStatus?.({
          handle: this.handle,
        });
        const acpObservation = acpUsageObservation(
          status?.usage,
          finalStatus?.usage,
          observationIdentity,
        );
        const nativeObservation = nativeUsageObservation(
          nativeBefore,
          await captureNativeUsage(spec, this.handle.backendSessionId),
          observationIdentity,
        );
        const observation =
          nativeObservation.scope === "run" &&
          nativeObservation.tokens.input !== null &&
          nativeObservation.tokens.output !== null
            ? nativeObservation
            : acpObservation;
        if (
          observation.cost.amount === null &&
          acpObservation.cost.amount !== null
        )
          observation.cost = acpObservation.cost;
        await channel.emit({
          type: "event",
          event: {
            type: "engine.usage",
            data: {
              source: "acp-session-checkpoint",
              models: finalStatus?.models ? json(finalStatus.models) : null,
              usage: finalStatus?.usage ? json(finalStatus.usage) : null,
              observation: json(observation),
              nativeMissingReason: nativeObservation.missingReason,
              sessionObservation:
                nativeObservation.scope === "session"
                  ? json(nativeObservation)
                  : null,
            },
          },
        });
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
            if (result.error.detailCode === "SESSION_RESUME_REQUIRED")
              throw new AcpSessionRecoveryError();
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
    } catch (error) {
      if (isRequestedModelUnsupportedError(error))
        return {
          status: "failed",
          error: {
            code: "ACP_MODEL_UNSUPPORTED",
            message:
              "The engine did not advertise the configured model or ACP model-selection capability",
          },
        };
      if (error instanceof AcpSessionRecoveryError)
        return {
          status: "failed",
          stopReason: "session_recovery_failed",
          error: { code: error.code, message: error.message },
        };
      throw error;
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
    // Duplicate IDs cannot preserve the user's exact selection. Multiple
    // different options with the same kind remain independently selectable.
    if (
      !options.length ||
      new Set(options.map((option) => option.id)).size !== options.length
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
      return { outcome: "selected", optionId: selected.id };
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
    this.store = undefined;
  }
}

function recoveryUnsupported(): DriverResult {
  return {
    status: "failed",
    stopReason: "session_recovery_unsupported",
    error: {
      code: "ACP_SESSION_RECOVERY_UNSUPPORTED",
      message:
        "ACP session recovery must be enabled and advertised by the engine",
    },
  };
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
