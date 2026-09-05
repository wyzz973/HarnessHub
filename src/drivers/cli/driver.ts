import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ExecutionSpec } from "../../domain/ports.js";
import type { DriverResult } from "../../domain/types.js";
import type { Driver, DriverChannel } from "../driver.js";

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function failed(code: string, message: string): DriverResult {
  return {
    status: "failed",
    stopReason: "cli_error",
    error: { code, message },
  };
}

/** Each Run owns a fresh CLI process; no history, permissions, or SDK state is inferred. */
export class CliDriver implements Driver {
  private active:
    { abort: AbortController; completion: Promise<DriverResult> } | undefined;
  private closed = false;

  async execute(
    spec: ExecutionSpec,
    channel: DriverChannel,
    signal: AbortSignal,
  ): Promise<DriverResult> {
    if (this.closed || this.active)
      throw new Error("CLI driver is closed or already executing");
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) abort.abort();
    const completion = this.run(spec, channel, abort.signal);
    const active = { abort, completion };
    this.active = active;
    try {
      return await completion;
    } finally {
      signal.removeEventListener("abort", cancel);
      if (this.active === active) this.active = undefined;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const active = this.active;
    if (!active) return;
    active.abort.abort();
    await active.completion;
  }

  private async run(
    spec: ExecutionSpec,
    channel: DriverChannel,
    signal: AbortSignal,
  ): Promise<DriverResult> {
    if (signal.aborted) return { status: "cancelled", stopReason: "cancelled" };
    const configuration = spec.profile.cli;
    const command = spec.profile.command;
    if (!configuration || !command?.[0])
      throw new Error("Validated CLI configuration is required");
    const args = command
      .slice(1)
      .map((argument) =>
        configuration.inputMode === "argv" && argument === "{prompt}"
          ? spec.input.text
          : argument,
      );
    // Never detach: ProcessHost owns the Worker group, including CLI descendants.
    // Stderr can contain credentials or provider configuration and is not published.
    const start = () =>
      spawn(command[0]!, args, {
        cwd: spec.cwd,
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    let child: ReturnType<typeof start>;
    try {
      child = start();
    } catch {
      return failed("CLI_SPAWN_ERROR", "Engine process could not start");
    }
    let failure: DriverResult | undefined;
    let exited = false;
    let escalation: NodeJS.Timeout | undefined;
    const exit = Promise.withResolvers<Exit>();
    child.once("error", () => {
      failure = failed("CLI_SPAWN_ERROR", "Engine process could not start");
      exited = true;
      exit.resolve({ code: null, signal: null });
    });
    child.once("exit", (code, reason) => {
      exited = true;
      exit.resolve({ code, signal: reason });
    });
    const stop = () => {
      child.stdout.destroy();
      child.stdin.destroy();
      if (exited || escalation) return;
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 250);
    };
    const inputError = () => {
      failure ??= failed(
        "CLI_INPUT_ERROR",
        "Engine process did not accept input",
      );
      stop();
    };
    child.stdin.on("error", inputError);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const input = new Promise<void>((resolve) => {
      child.stdin.end(
        configuration.inputMode === "stdin" ? spec.input.text : undefined,
        "utf8",
        () => resolve(),
      );
    });
    const decoder = new StringDecoder("utf8");
    const output: string[] = [];
    let bytes = 0;
    const emit = async (text: string) => {
      if (!text) return;
      output.push(text);
      await channel.emit({
        type: "event",
        event: {
          type: "message.delta",
          data: { text, messageId: spec.runId, stream: "output" },
        },
      });
    };
    try {
      try {
        for await (const raw of child.stdout) {
          if (signal.aborted || failure) break;
          // Node pipe data is a Buffer unless an encoding is configured.
          if (!Buffer.isBuffer(raw))
            throw new Error("Invalid CLI output chunk");
          bytes += raw.byteLength;
          if (bytes > configuration.maxOutputBytes) {
            failure = failed(
              "CLI_OUTPUT_LIMIT",
              "Engine output exceeded the configured byte limit",
            );
            stop();
            break;
          }
          await emit(decoder.write(raw));
        }
      } catch (error) {
        if (!signal.aborted && !failure) throw error;
      }
      if (!signal.aborted && !failure) await emit(decoder.end());
      const outcome = await exit.promise;
      await input;
      if (signal.aborted)
        return { status: "cancelled", stopReason: "cancelled" };
      if (failure) return failure;
      if (outcome.signal)
        return failed(
          "CLI_PROCESS_SIGNAL",
          "Engine process exited after a signal",
        );
      if (outcome.code !== 0)
        return failed(
          "CLI_EXIT_NONZERO",
          "Engine process exited with a nonzero status",
        );
      return {
        status: "completed",
        stopReason: "process_exit",
        output: output.join(""),
      };
    } finally {
      stop();
      await exit.promise;
      if (escalation) clearTimeout(escalation);
      signal.removeEventListener("abort", stop);
    }
  }
}
