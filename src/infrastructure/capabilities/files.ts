import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CapabilityError } from "../../contracts/capabilities.js";
import { sha256 } from "./store.js";

export const MAX_TARGET_BYTES = 8 * 1024 * 1024;
/** A Harness's configuration file as HarnessHub may write it: missing, readable with its mode, or refused with the reason. */
export type TargetRead =
  | { readonly state: "missing"; readonly directory: boolean }
  | { readonly state: "ok"; readonly bytes: Buffer; readonly mode: number }
  | { readonly state: "refused"; readonly reason: string };

function code(error: unknown): string { return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : ""; }
/** Reads a target without following a link at its own name: a link or a file with other hard links is refused, not written through. */
export function readTarget(file: string): TargetRead {
  let info;
  try { info = lstatSync(file); }
  catch (error) {
    if (code(error) !== "ENOENT") return { state: "refused", reason: "无法读取（" + (code(error) || "未知错误") + "）" };
    let directory = false; try { directory = statSync(dirname(file)).isDirectory(); } catch { directory = false; }
    return { state: "missing", directory };
  }
  if (info.isSymbolicLink()) return { state: "refused", reason: "这个文件是符号链接（多见于 dotfiles 管理工具），HarnessHub 不经链接写入" };
  if (!info.isFile()) return { state: "refused", reason: "这不是普通文件" };
  if (info.nlink > 1) return { state: "refused", reason: "这个文件有其他硬链接，替换写入会断开它们" };
  if (info.size > MAX_TARGET_BYTES) return { state: "refused", reason: "文件超过 8 MB" };
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(info.size); let length = 0;
    while (length < bytes.length) { const received = readSync(descriptor, bytes, length, bytes.length - length, length); if (received === 0) break; length += received; }
    return { state: "ok", bytes: bytes.subarray(0, length), mode: info.mode & 0o7777 };
  } finally { closeSync(descriptor); }
}
function unchanged(file: string, expected: string | null): void {
  const current = readTarget(file);
  const same = expected === null ? current.state === "missing" : current.state === "ok" && sha256(current.bytes) === expected;
  if (!same) throw new CapabilityError("CAPABILITY_TARGET_CHANGED", "文件在确认之后被改动过，没有写入；请重新检查");
}
/**
 * Replaces a target with `bytes` atomically: a temporary file beside it with the same mode (whatever the process's
 * umask) is written and synced, the
 * target is compared with `expected` (its hash, or null for absent) once more, and only then renamed over it.
 * Throws `CAPABILITY_TARGET_CHANGED` and writes nothing when the target is not as expected.
 */
export function replaceTarget(file: string, expected: string | null, bytes: Buffer, mode: number): void {
  unchanged(file, expected);
  const temporary = join(dirname(file), "." + basename(file) + ".harnesshub-" + randomUUID() + ".tmp");
  const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
    // The mode is set explicitly: a Gateway started with umask 077 would otherwise leave a 0644 file 0600.
    try { fchmodSync(descriptor, mode); let written = 0; while (written < bytes.length) written += writeSync(descriptor, bytes, written, bytes.length - written); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    unchanged(file, expected);
    renameSync(temporary, file); renamed = true;
    const directory = openSync(dirname(file), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { if (!renamed) { try { unlinkSync(temporary); } catch { /* not created or already gone */ } } }
}
