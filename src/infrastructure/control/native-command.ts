import { darwinExitedGroupIsQuiescent } from "./process-group.js";
import { spawn } from "node:child_process";
import { ControlError } from "./json-rpc-process.js";
import type { ControlLaunch, ControlOptions } from "../../contracts/control.js";

/** Runs an installed CLI command; abort and exit both await its process group before returning bounded stdout. */
export function nativeCommand(launch: ControlLaunch, args: readonly string[], options: ControlOptions, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(new ControlError("CANCELLED", "native command cancelled"));
  return new Promise((resolve, reject) => {
    const child = spawn(launch.executable, [...args], { cwd: options.cwd, env: { ...options.env, ...launch.env }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let bytes = 0, failure: unknown = null; let pipeTimer:ReturnType<typeof setTimeout>|null=null, closing=false;
    const kill = () => { if(!closing&&pipeTimer===null)pipeTimer=setTimeout(()=>{failure??=new ControlError("CLEANUP_FAILED","native command descendants retained pipes");child.stdout.destroy();child.stderr.destroy();},2500); try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch (error) { if(error!==null&&typeof error==="object"&&"code"in error&&error.code==="EPERM"&&child.pid&&(child.exitCode!==null||child.signalCode!==null))return; if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH")) failure ??= new ControlError("CLEANUP_FAILED", "native command cleanup unconfirmed"); } };
    const timeout = setTimeout(() => { failure = new ControlError("REQUEST_TIMEOUT", "native command exceeded its deadline"); kill(); }, options.requestTimeoutMs);
    signal.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > options.maxFrameBytes) { failure = new ControlError("OUTPUT_LIMIT", "native command output exceeded its budget"); kill(); } else chunks.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > options.maxFrameBytes + options.maxDiagnosticBytes) { failure = new ControlError("OUTPUT_LIMIT", "native command diagnostics exceeded their budget"); kill(); } });
    child.once("error", () => { failure ??= new ControlError("PROCESS_START_FAILED", "native command could not start"); });
    child.once("close", (code, exitSignal) => { void (async () => {
      closing=true; clearTimeout(timeout); if(pipeTimer!==null)clearTimeout(pipeTimer); signal.removeEventListener("abort", kill);
      if (process.platform !== "win32" && child.pid) {
        const alive = () => { try { process.kill(-child.pid!, 0); return true; } catch (error) { if (error !== null && typeof error === "object" && "code" in error && (error.code === "ESRCH" || error.code==="EPERM"&&darwinExitedGroupIsQuiescent(child.pid!))) return false; if(error!==null&&typeof error==="object"&&"code"in error&&error.code==="EPERM")return true; throw new ControlError("CLEANUP_FAILED", "native command ownership unconfirmed"); } };
        if (alive()) { kill(); const until = Date.now() + 2000; while (alive() && Date.now() < until) await new Promise<void>(done => setTimeout(done, 25)); if (alive()) throw new ControlError("CLEANUP_FAILED", "native command descendants remained alive"); }
      }
      if (failure) throw failure;
      if (signal.aborted) throw new ControlError("CANCELLED", "native command cancelled");
      if (code !== 0 || exitSignal !== null) throw new ControlError("NATIVE_REQUEST_FAILED", "original native CLI request failed");
      let output:string;try{output=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));}catch{throw new ControlError("INVALID_NATIVE_METADATA","native command emitted invalid UTF-8");}resolve(output);
    })().catch(reject); });
  });
}
