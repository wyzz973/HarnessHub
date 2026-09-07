import {
  prepareConfiguration,
  type PreparedConfiguration,
} from "../drivers/configuration/prepare.js";
import { HubError } from "../domain/errors.js";
import type { ExecutionSpec } from "../domain/ports.js";
import type { PermissionId, PermissionOption } from "../domain/types.js";
import type { Driver, DriverChannel } from "../drivers/driver.js";
import { FakeDriver } from "../drivers/fake/driver.js";
import { AcpDriver } from "../drivers/acp/driver.js";
import { CliDriver } from "../drivers/cli/driver.js";
import {
  assertMessageSize,
  matchesIdentity,
  parseHostCommand,
  type WorkerPayload,
} from "../domain/ipc.js";

interface PermissionWaiter {
  options: PermissionOption[];
  resolve: (optionId: string) => void;
  reject: (error: unknown) => void;
}
interface Active {
  spec: ExecutionSpec;
  abort: AbortController;
  seq: number;
  ack?: {
    seq: number;
    terminal: boolean;
    resolve: () => void;
    reject: (error: unknown) => void;
  };
  delivery: Promise<void>;
  permissions: Map<PermissionId, PermissionWaiter>;
  completion: Promise<void>;
}
let active: Active | undefined;
let driver: Driver | undefined;
let preparation: PreparedConfiguration | undefined;
let anchor: string | undefined;
let shuttingDown: Promise<void> | undefined;

function send(value: unknown): Promise<void> {
  assertMessageSize(value);
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error("Parent IPC unavailable"));
      return;
    }
    // JSON serialization is the Node IPC boundary; outgoing values are built from typed messages.
    process.send(JSON.parse(JSON.stringify(value)), (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function emit(owned: Active, payload: WorkerPayload): Promise<void> {
  const delivered = owned.delivery.then(async () => {
    if (active !== owned) throw new Error("Execution ownership changed");
    const seq = ++owned.seq;
    const ack = Promise.withResolvers<void>();
    owned.ack = {
      seq,
      terminal: payload.type === "result",
      resolve: ack.resolve,
      reject: ack.reject,
    };
    try {
      await send({
        version: 1,
        sessionId: owned.spec.sessionId,
        runId: owned.spec.runId,
        generation: owned.spec.generation,
        seq,
        ...payload,
      });
      await ack.promise;
    } finally {
      delete owned.ack;
    }
  });
  owned.delivery = delivered;
  return delivered;
}

function createChannel(owned: Active): DriverChannel {
  return {
    emit: (payload) => emit(owned, payload),
    permission: async (request, signal) => {
      signal.throwIfAborted();
      if (owned.permissions.has(request.id))
        throw new Error("Duplicate permission identity");
      const decision = Promise.withResolvers<string>();
      // A cancellation may reject before request delivery completes; observe immediately.
      void decision.promise.catch(() => undefined);
      const abort = () => decision.reject(new Error("Permission cancelled"));
      owned.permissions.set(request.id, {
        options: request.options,
        resolve: decision.resolve,
        reject: decision.reject,
      });
      signal.addEventListener("abort", abort, { once: true });
      try {
        await emit(owned, { type: "permission", permission: request });
        const optionId = await decision.promise;
        signal.throwIfAborted();
        await emit(owned, {
          type: "permission_applied",
          permissionId: request.id,
        });
        return optionId;
      } finally {
        signal.removeEventListener("abort", abort);
        owned.permissions.delete(request.id);
      }
    },
  };
}

async function execute(owned: Active, selected: Driver): Promise<void> {
  try {
    await emit(owned, { type: "started" });
    preparation ??= await prepareConfiguration(owned.spec, process.env);
    preparation.modelBridge?.beginRun(owned.abort.signal);
    // This process belongs to one Session; no Gateway or other Worker's environment is changed.
    Object.assign(process.env, preparation.env);
    if (selected instanceof AcpDriver) {
      selected.configureMcp(preparation.mcpServers);
      selected.configureNativeModelSelection(
        preparation.nativeModelSelection ?? false,
      );
    }
    const executionSpec = {
      ...owned.spec,
      profile: {
        ...owned.spec.profile,
        command: preparation.command,
        ...(preparation.model ? { model: preparation.model } : {}),
      },
      input: {
        ...owned.spec.input,
        text: preparation.instructionPrefix + owned.spec.input.text,
      },
    };
    const result = await selected.execute(
      executionSpec,
      createChannel(owned),
      owned.abort.signal,
    );
    await preparation.modelBridge?.endRun();
    await emit(owned, { type: "result", result });
  } catch (error) {
    await preparation?.modelBridge?.endRun();
    if (!process.connected) throw error;
    // Public errors intentionally exclude backend stderr, credentials, and raw configuration.
    await emit(owned, {
      type: "result",
      result: {
        status: owned.abort.signal.aborted ? "cancelled" : "failed",
        stopReason: owned.abort.signal.aborted ? "cancelled" : "driver_error",
        error: {
          code: error instanceof HubError ? error.code : "DRIVER_ERROR",
          message:
            error instanceof HubError
              ? error.message
              : "Engine execution failed; inspect the local engine configuration",
        },
      },
    });
  } finally {
    for (const waiter of owned.permissions.values())
      waiter.reject(new Error("Execution ended"));
    owned.permissions.clear();
    if (active === owned) active = undefined;
  }
}

function shutdown(): Promise<void> {
  if (shuttingDown) return shuttingDown;
  shuttingDown = (async () => {
    const owned = active;
    if (owned) {
      owned.abort.abort();
      if (!process.connected)
        owned.ack?.reject(new Error("Parent disconnected"));
      await owned.completion.catch(() => undefined);
    }
    try {
      await driver?.close();
    } finally {
      await preparation?.modelBridge?.close();
    }
  })();
  return shuttingDown;
}
function fatal(): void {
  if (active) {
    active.abort.abort();
    active.ack?.reject(new Error("Worker protocol failed"));
  }
  void shutdown().then(
    () => process.exit(70),
    () => process.exit(70),
  );
}

process.on("message", (raw: unknown) => {
  try {
    const command = parseHostCommand(raw);
    if (command.type === "shutdown") {
      void shutdown().then(
        () => process.exit(0),
        () => process.exit(71),
      );
      return;
    }
    if (command.type === "run") {
      if (active || shuttingDown) throw new Error("Worker is not idle");
      const binding = JSON.stringify([
        command.spec.sessionId,
        command.spec.profile,
        command.spec.cwd,
        command.spec.stateDir,
      ]);
      if (anchor !== undefined && anchor !== binding)
        throw new Error("Worker binding changed");
      anchor = binding;
      if (!driver) {
        switch (command.spec.profile.driver) {
          case "fake":
            driver = new FakeDriver();
            break;
          case "acp":
            driver = new AcpDriver();
            break;
          case "cli":
            driver = new CliDriver();
            break;
        }
      }
      const owned: Active = {
        spec: command.spec,
        abort: new AbortController(),
        seq: 0,
        delivery: Promise.resolve(),
        permissions: new Map(),
        completion: Promise.resolve(),
      };
      active = owned;
      owned.completion = execute(owned, driver);
      void owned.completion.catch(() => fatal());
      return;
    }
    const owned = active;
    if (!owned || !matchesIdentity(command, owned.spec))
      throw new Error("Stale Worker control");
    switch (command.type) {
      case "ack":
        if (owned.ack?.seq !== command.seq)
          throw new Error("Unexpected delivery acknowledgement");
        // The host may send the next Run immediately after its result ACK, in
        // the same IPC delivery batch. Release ownership synchronously, after
        // all Driver/bridge work finished and before resolving the awaiter.
        if (owned.ack.terminal) active = undefined;
        owned.ack.resolve();
        break;
      case "cancel":
        owned.abort.abort();
        break;
      case "permission": {
        const waiter = owned.permissions.get(command.permissionId);
        if (
          !waiter ||
          !waiter.options.some((option) => option.id === command.optionId)
        )
          throw new Error("Invalid permission response");
        waiter.resolve(command.optionId);
        break;
      }
    }
  } catch {
    fatal();
  }
});

process.once("disconnect", () => {
  void shutdown().then(
    () => process.exit(0),
    () => process.exit(71),
  );
});
void send({ version: 1, type: "ready", pid: process.pid }).catch(() => fatal());
