import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { PreparedConfiguration } from "./prepare.js";
import type { ConfigurationCheck } from "../../domain/engine-configuration.js";
/** Read-only ACP initialize probe. Owns a process group, bounded output/time and awaited cleanup; never prompts. */
export async function probeConfiguration(
  prepared: PreparedConfiguration,
  driver: string,
  cwd: string,
  signal: AbortSignal,
): Promise<ConfigurationCheck> {
  const executable = prepared.command[0];
  if (!executable)
    return {
      name: "launch",
      status: "failed",
      message: "No executable configured",
    };
  await access(executable, constants.X_OK);
  if (driver !== "acp")
    return {
      name: "launch",
      status: "passed",
      message:
        "CLI executable and configuration resolved; model/authentication were not called",
    };
  if (process.platform === "win32")
    return {
      name: "protocol",
      status: "failed",
      message: "ACP probe process-tree cleanup requires Windows validation",
    };
  signal.throwIfAborted();
  const child = spawn(executable, prepared.command.slice(1), {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      LANG: process.env.LANG ?? "",
      ...prepared.env,
    },
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let result: ConfigurationCheck = {
    name: "protocol",
    status: "failed",
    message: "ACP initialize did not complete",
  };
  let bytes = 0,
    buffer = "";
  const settled = Promise.withResolvers<void>();
  const closed = new Promise<void>((resolve) => {
    child.once("error", () => {
      settled.resolve();
      resolve();
    });
    child.once("close", () => {
      settled.resolve();
      resolve();
    });
  });
  const stop = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ESRCH"
        ))
          throw error;
      }
    }
    settled.resolve();
  };
  signal.addEventListener("abort", stop, { once: true });
  const timeout = setTimeout(stop, 10_000);
  child.stdin.on("error", () => {
    /* process termination settles the probe */
  });
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 262144) {
      stop();
      return;
    }
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      let raw: unknown;
      try {
        raw = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (raw && typeof raw === "object" && "id" in raw && raw.id === 1) {
        if (
          "result" in raw &&
          raw.result &&
          typeof raw.result === "object" &&
          "protocolVersion" in raw.result &&
          raw.result.protocolVersion === 1
        )
          result = {
            name: "protocol",
            status: "passed",
            message:
              "ACP v1 initialize succeeded; provider authentication/model execution are not verified",
          };
        settled.resolve();
      }
    }
  });
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "HarnessHub configuration test", version: "0.1.0" },
      },
    }) + "\n",
  );
  try {
    await settled.promise;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", stop);
    stop();
    const escalation = setTimeout(() => {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH"
          ))
            throw error;
        }
    }, 1000);
    try {
      await closed;
    } finally {
      clearTimeout(escalation);
    }
  }
  if (child.pid) {
    const deadline = Date.now() + 1000;
    for (;;) {
      try {
        process.kill(-child.pid, 0);
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH")
          break;
        throw error;
      }
      if (Date.now() >= deadline)
        return {
          name: "cleanup",
          status: "failed",
          message: "Probe descendants could not be confirmed absent",
        };
      await delay(20);
    }
  }
  if (child.pid)
    try {
      process.kill(-child.pid, 0);
      return {
        name: "cleanup",
        status: "failed",
        message: "Probe process group remains alive",
      };
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error;
    }
  return result;
}
