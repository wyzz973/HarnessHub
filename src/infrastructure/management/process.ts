import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { ManagementError, type ManagementInstallContext } from "../../contracts/management.js";

/** Owns the process group and pipes until close; cancellation is not reported as completion. */
export function runManagementProcess(executable: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>,
  context: ManagementInstallContext, captureLimit = 128 * 1024): Promise<string> {
  if (context.signal.aborted) return Promise.reject(new ManagementError("CANCELLED", "installation was cancelled"));
  context.assertOwned();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const captured: Buffer[] = []; let size = 0, stopping = false, failure: unknown = null;
    const lines = { stdout: "", stderr: "" }, decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let pipeTimer: ReturnType<typeof setTimeout> | null = null;
    const kill = (signal: "SIGTERM" | "SIGKILL"): void => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch (error) { if (error === null || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") failure ??= new ManagementError("CLEANUP_FAILED", "installer process cleanup could not be confirmed"); }
    };
    const stop = (): void => {
      if (stopping) return; stopping = true; kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), 500);
      pipeTimer = setTimeout(() => {
        failure ??= new ManagementError("CLEANUP_FAILED", "installer descendants retained output pipes after termination");
        kill("SIGKILL"); child.stdout.destroy(); child.stderr.destroy();
      }, 2500);
    };
    const chunk = (stream: "stdout" | "stderr", bytes: Buffer): void => {
      size += bytes.length;
      if (size > captureLimit) { failure = new ManagementError("OUTPUT_LIMIT", "installer output exceeded its byte budget"); stop(); return; }
      if (stream === "stdout") captured.push(bytes);
      try {
        context.assertOwned(); lines[stream] += decoders[stream].write(bytes);
        if (Buffer.byteLength(lines[stream], "utf8") > 65536) throw new ManagementError("OUTPUT_LIMIT", "installer output line exceeded its byte budget");
        const complete = lines[stream].split(/[\r\n]/u); lines[stream] = complete.pop() ?? "";
        for (const line of complete) if (line) context.log(stream, line);
      } catch (error) { failure = error; stop(); }
    };
    child.stdout.on("data", (bytes: Buffer) => chunk("stdout", bytes)); child.stderr.on("data", (bytes: Buffer) => chunk("stderr", bytes));
    child.once("error", () => { failure ??= new ManagementError("PROCESS_START_FAILED", "installer process could not be started"); });
    context.signal.addEventListener("abort", stop, { once: true });
    child.once("close", (code, signal) => { void (async () => {
      context.signal.removeEventListener("abort", stop); if (killTimer !== null) clearTimeout(killTimer); if (pipeTimer !== null) clearTimeout(pipeTimer);
      if (process.platform !== "win32" && child.pid) {
        const alive = (): boolean => { try { process.kill(-child.pid!, 0); return true; } catch (error) { return error === null || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH"; } };
        if (alive()) {
          kill("SIGTERM"); const deadline = Date.now() + 2000;
          while (alive() && Date.now() < deadline) { kill("SIGKILL"); await new Promise<void>(ready => setTimeout(ready, 25)); }
          if (alive()) failure ??= new ManagementError("CLEANUP_FAILED", "installer descendants did not reach quiescence");
        }
      }
      try { for (const stream of ["stdout", "stderr"] as const) { const tail = lines[stream] + decoders[stream].end(); if (tail) context.log(stream, tail); } }
      catch (error) { failure ??= error; }
      if (failure !== null) { reject(failure); return; }
      if (context.signal.aborted) { reject(new ManagementError("CANCELLED", "installation was cancelled")); return; }
      if (code !== 0 || signal !== null) { reject(new ManagementError("PROCESS_FAILED", "installer command exited unsuccessfully")); return; }
      resolve(Buffer.concat(captured).toString("utf8"));
    })().catch(reject); });
  });
}
