import type {
  ExecutionIdentity,
  ExecutionSpec,
  WorkerMessage,
} from "../domain/ports.js";
import type {
  DriverResult,
  PermissionId,
  PermissionOption,
} from "../domain/types.js";
type WorkerPayload = WorkerMessage extends infer Message
  ? Message extends WorkerMessage
    ? Omit<Message, keyof ExecutionIdentity | "version" | "seq">
    : never
  : never;

/** Worker owns delivery and permission waiters; Driver awaits delivery backpressure. */
export interface DriverChannel {
  emit(payload: WorkerPayload): Promise<void>;
  permission(
    request: {
      id: PermissionId;
      toolCallId: string;
      prompt: string;
      options: PermissionOption[];
    },
    signal: AbortSignal,
  ): Promise<string>;
}
/** One driver instance owns exactly one backend session and releases it on close. */
export interface Driver {
  execute(
    spec: ExecutionSpec,
    channel: DriverChannel,
    signal: AbortSignal,
  ): Promise<DriverResult>;
  close(): Promise<void>;
}
