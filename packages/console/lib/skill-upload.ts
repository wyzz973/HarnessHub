// SPDX-License-Identifier: MIT
/**
 * A skill uploaded from the browser (`POST /library/skills` with `files`,
 * docs/library.md): read from a picked folder or a zip file, checked
 * against the daemon's limits before anything is sent, and encoded as the
 * API takes it. The daemon checks everything again.
 */
import type { LibraryAgent } from "@harnesshub/sdk/client";
import { t } from "./i18n";

/** The daemon's limits of one skill (docs/library.md). */
export const SKILL_LIMITS = { files: 500, bytes: 20 * 1024 * 1024 } as const;

export interface SkillFile {
  /** Below the skill directory, with `/`. */
  path: string;
  bytes: Uint8Array;
  exec: boolean;
}

/** Entries the daemon ignores in a skill directory (`.DS_Store`, `.git`). */
export function ignored(path: string): boolean {
  const parts = path.split("/");
  return parts.includes(".git") || parts.at(-1) === ".DS_Store";
}

const ZIP = {
  end: 0x06054b50,
  central: 0x02014b50,
  local: 0x04034b50,
} as const;

async function inflate(raw: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([raw])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The files of a zip archive: stored and deflated entries, with the
 * executable bit of archives made on Unix. Links, encrypted entries and
 * ZIP64 archives are refused; so is an archive whose files exceed the
 * skill limits, before it is inflated.
 */
export async function readZip(data: ArrayBuffer): Promise<SkillFile[]> {
  const view = new DataView(data);
  const size = data.byteLength;
  let end = -1;
  for (let at = size - 22; at >= Math.max(0, size - 22 - 0xffff); at--)
    if (view.getUint32(at, true) === ZIP.end) {
      end = at;
      break;
    }
  if (end < 0) throw new Error(t("library.zip.notZip"));
  const count = view.getUint16(end + 10, true);
  const directory = view.getUint32(end + 16, true);
  if (count === 0xffff || directory === 0xffffffff)
    throw new Error(t("library.zip.zip64"));
  const names = new TextDecoder();
  const entries: Array<{
    path: string;
    method: number;
    compressed: number;
    size: number;
    local: number;
    exec: boolean;
  }> = [];
  let at = directory;
  for (let index = 0; index < count; index++) {
    if (at + 46 > size || view.getUint32(at, true) !== ZIP.central)
      throw new Error(t("library.zip.corrupt"));
    const madeBy = view.getUint16(at + 4, true);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const length = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const external = view.getUint32(at + 38, true);
    const local = view.getUint32(at + 42, true);
    const path = names.decode(new Uint8Array(data, at + 46, nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new Error(t("library.zip.encrypted", { path }));
    const mode = madeBy >> 8 === 3 ? external >>> 16 : 0;
    if ((mode & 0o170000) === 0o120000)
      throw new Error(t("library.zip.link", { path }));
    if (path.endsWith("/") || ignored(path)) continue;
    entries.push({
      path,
      method,
      compressed,
      size: length,
      local,
      exec: (mode & 0o111) !== 0,
    });
  }
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (entries.length > SKILL_LIMITS.files)
    throw new Error(
      t("library.zip.tooMany", {
        count: entries.length,
        limit: SKILL_LIMITS.files,
      }),
    );
  if (total > SKILL_LIMITS.bytes)
    throw new Error(t("library.zip.tooLarge", { size: bytes(total) }));
  const files: SkillFile[] = [];
  for (const entry of entries) {
    if (view.getUint32(entry.local, true) !== ZIP.local)
      throw new Error(t("library.zip.corrupt"));
    const start =
      entry.local +
      30 +
      view.getUint16(entry.local + 26, true) +
      view.getUint16(entry.local + 28, true);
    const raw = new Uint8Array(data, start, entry.compressed);
    const content =
      entry.method === 0
        ? raw.slice()
        : entry.method === 8
          ? await inflate(raw)
          : undefined;
    if (!content)
      throw new Error(
        t("library.zip.method", {
          path: entry.path,
          method: String(entry.method),
        }),
      );
    if (content.length !== entry.size)
      throw new Error(t("library.zip.size", { path: entry.path }));
    files.push({ path: entry.path, bytes: content, exec: entry.exec });
  }
  return files;
}

function bytes(size: number): string {
  return size < 1024 * 1024
    ? `${(size / 1024).toFixed(1)} KiB`
    : `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * The skill in picked files: entries the daemon ignores are left out, and
 * a single top folder (a picked folder, or a zip of one) becomes the
 * skill's name. `problems` say why it cannot be uploaded as it is.
 */
export function skillOf(
  picked: readonly SkillFile[],
  fallbackName: string,
): { name: string; files: SkillFile[]; size: number; problems: string[] } {
  let files = picked.filter((file) => !ignored(file.path));
  let name = fallbackName;
  const tops = new Set(files.map((file) => file.path.split("/")[0]));
  if (
    tops.size === 1 &&
    files.length &&
    files.every((file) => file.path.includes("/"))
  ) {
    name = [...tops][0]!;
    files = files.map((file) => ({
      ...file,
      path: file.path.slice(name.length + 1),
    }));
  }
  const size = files.reduce((sum, file) => sum + file.bytes.length, 0);
  const problems: string[] = [];
  if (!files.length) problems.push(t("library.skill.noFiles"));
  if (files.length > SKILL_LIMITS.files)
    problems.push(
      t("library.skill.tooMany", {
        count: files.length,
        limit: SKILL_LIMITS.files,
      }),
    );
  if (size > SKILL_LIMITS.bytes)
    problems.push(t("library.skill.tooLarge", { size: bytes(size) }));
  if (files.length && !files.some((file) => file.path === "SKILL.md"))
    problems.push(t("library.skill.noSkillMd"));
  return { name, files, size, problems };
}

/** Base64 of bytes, in chunks small enough for `String.fromCharCode`. */
export function base64(content: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < content.length; at += 0x8000)
    binary += String.fromCharCode(...content.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** The `upload` request of a skill. */
export function uploadInput(
  name: string,
  files: readonly SkillFile[],
  agents: readonly LibraryAgent[],
): {
  name: string;
  files: Record<string, string>;
  exec?: string[];
  agents: LibraryAgent[];
} {
  const exec = files.filter((file) => file.exec).map((file) => file.path);
  return {
    name,
    files: Object.fromEntries(
      files.map((file) => [file.path, base64(file.bytes)]),
    ),
    ...(exec.length ? { exec } : {}),
    agents: [...agents],
  };
}
