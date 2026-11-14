import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { relative, sep } from "node:path";
import { SessionError } from "../../contracts/session.js";
import type { WorkspaceFileView } from "../../contracts/web.js";
import { placeInWorkspace } from "./place.js";

/*
 * A file of a conversation's workspace as the page shows it (2026-11-14): read only, a page at a time, the pages cut between characters of UTF-8 so that each decodes on
 * its own. A file that looks binary (a NUL in its first bytes, as Git judges) is told as such and not read.
 */

/** How many bytes one page holds at most. */
export const FILE_PAGE_BYTES = 256 * 1024;
/** How much of a file's start is looked at to tell whether it is binary. */
const SNIFF_BYTES = 8 * 1024;

/** Whether the byte is the second, third or fourth of a UTF-8 character. */
const continuation = (byte: number): boolean => (byte & 0xc0) === 0x80;
/** How many bytes the UTF-8 character that starts with this byte has (1 for a byte that starts none). */
const width = (byte: number): number => byte >= 0xf0 && byte <= 0xf7 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;

/**
 * The page of `path` (relative to the workspace, or absolute; its real path must be in the workspace) that starts at `offset`: its text, and where the next page starts
 * (null at the end). An offset inside a character starts at the next character. A directory is refused (INVALID_INPUT), a file not there is not found (FILE_NOT_FOUND),
 * an offset past the end is refused. Bytes that are not UTF-8 read as U+FFFD.
 */
export async function readWorkspaceFile(workspace: string, path: string, offset = 0): Promise<WorkspaceFileView> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new SessionError("INVALID_INPUT", "offset 是从 0 起的字节数");
  const { root, target } = await placeInWorkspace(workspace, path, "只能读这个对话工作区里的文件");
  const shown = relative(root, target).split(sep).join("/");
  // Not blocking: a FIFO in the workspace is refused for what it is, not waited on.
  const handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK).catch((error: unknown) => {
    const code = (error as { readonly code?: unknown } | null)?.code;
    if (code === "ENOENT") throw new SessionError("FILE_NOT_FOUND", "这个文件已不在");
    if (code === "EISDIR") throw new SessionError("INVALID_INPUT", "这是一个文件夹，不是文件");
    throw error;
  });
  try {
    const info = await handle.stat();
    if (info.isDirectory()) throw new SessionError("INVALID_INPUT", "这是一个文件夹，不是文件");
    if (!info.isFile()) throw new SessionError("INVALID_INPUT", "这不是一个普通文件");
    const size = info.size;
    if (offset > size) throw new SessionError("INVALID_INPUT", "offset 超出了文件的长度");
    const sniff = Buffer.alloc(Math.min(SNIFF_BYTES, size)), sniffed = (await handle.read(sniff, 0, sniff.length, 0)).bytesRead;
    if (sniff.subarray(0, sniffed).includes(0)) return { path: shown, size, binary: true };
    // Three bytes more than a page, to finish the character the page would end inside; three before, to find where a character starts when `offset` is inside one.
    const from = Math.max(0, offset - 3), want = Math.min(size - from, offset - from + FILE_PAGE_BYTES + 3);
    const buffer = Buffer.alloc(want), read = (await handle.read(buffer, 0, want, from)).bytesRead, bytes = buffer.subarray(0, read);
    let start = offset - from;
    while (start < bytes.length && start < offset - from + 3 && continuation(bytes[start]!)) start++;
    let end = Math.min(bytes.length, start + FILE_PAGE_BYTES);
    if (from + end < size) {
      // The page ends before a character that would not be whole in it: its lead byte is among the last three, and the character runs past the end.
      for (let back = 1; back <= 3 && end - back > start; back++) {
        const byte = bytes[end - back]!;
        if (continuation(byte)) continue;
        if (width(byte) > back) end -= back;
        break;
      }
    }
    const at = from + start, next = from + end >= size ? null : from + end;
    return { path: shown, size, offset: at, text: new TextDecoder("utf-8").decode(bytes.subarray(start, end)), next };
  } finally { await handle.close(); }
}
