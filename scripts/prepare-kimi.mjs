/**
 * Build-machine-only fix of the fixed Kimi CLI 1.50.0 executable (kimi-cli, Apache-2.0).
 *
 * kimi.exe is a PyInstaller one-file program. Its bootloader starts Python with an isolated
 * configuration, so PYTHONUTF8 and PYTHONIOENCODING are ignored, and Python encodes a piped
 * stdout with the Windows ANSI code page. A reply outside that code page (Chinese on cp1252,
 * an emoji on cp936) ends the CLI with "'charmap' codec can't encode" after the task already
 * ran, and any other non-ASCII reply reaches the CLI Driver, which decodes UTF-8, in the
 * wrong encoding. PyInstaller's supported switch is a run-time option stored in the embedded
 * archive (`EXE(..., [("X utf8=1", None, "OPTION")])` in a spec file). This script appends
 * exactly that option entry to the archive's table of contents: Python then runs in UTF-8
 * mode and stdout/stderr are UTF-8 on every code page. Program code and data are unchanged;
 * only the table of contents, the archive cookie and the PE checksum differ.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Patched file, relative to a preparation root or bundle. */
export const KIMI_EXECUTABLE = path.join("engines", "kimi", "kimi.exe");
/** SHA-256 of kimi.exe from the pinned 1.50.0 archives, before and after the patch. */
export const KIMI_EXECUTABLES = Object.freeze({
  x64: Object.freeze({
    original:
      "38aa1d93aace51ace4980026f97981c81a2006443fc915b2bb8149d971182c0b",
    patched: "9291deb6503a3e635621c4fdecaf8e45972be31f1c417c13aa596d5f92893de9",
  }),
  arm64: Object.freeze({
    original:
      "f29831d0d1b10a9b5dd0afa8b63e96c16e1976a8c4ffcc007d239e08af69b7b7",
    patched: "a34013618e3735d5d8ceba83926cdb38f662e4e8d703969e28637129fed42ef8",
  }),
});
/** Run-time option name understood by the PyInstaller bootloader (`-X utf8=1`). */
export const KIMI_UTF8_OPTION = "X utf8=1";

const COOKIE_MAGIC = Buffer.from("4d45490c0b0a0b0e", "hex");
// magic 8, package length 4, TOC offset 4, TOC length 4, Python version 4, library name 64
const COOKIE_LENGTH = 88;
// entry length 4, data offset 4, compressed 4, uncompressed 4, compression flag 1, type 1
const ENTRY_HEADER_LENGTH = 18;
const OPTION_TYPE = "o".charCodeAt(0);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function invalid(message) {
  return new Error(
    `Not a supported PyInstaller one-file executable: ${message}`,
  );
}

/** Offset of the PE CheckSum field and end of the last section's file data. */
function readImage(file) {
  if (file.length < 0x40 || file.readUInt16LE(0) !== 0x5a4d)
    throw invalid("missing MZ header");
  const pe = file.readUInt32LE(0x3c);
  // The checksum is summed in 16-bit words, so its field must start on a word boundary.
  if (
    pe % 2 !== 0 ||
    pe + 24 + 68 > file.length ||
    file.readUInt32LE(pe) !== 0x00004550
  )
    throw invalid("missing PE header");
  const sections = file.readUInt16LE(pe + 6);
  const table = pe + 24 + file.readUInt16LE(pe + 20);
  if (table + sections * 40 > file.length)
    throw invalid("section table is truncated");
  let end = 0;
  for (let index = 0; index < sections; index++) {
    const entry = table + index * 40;
    end = Math.max(
      end,
      file.readUInt32LE(entry + 20) + file.readUInt32LE(entry + 16),
    );
  }
  // CheckSum is at optional-header offset 64 in both PE32 and PE32+.
  return { checksumOffset: pe + 24 + 64, end };
}

/** PE checksum as computed by imagehlp CheckSumMappedFile (the field itself counts as 0). */
function peChecksum(file, checksumOffset) {
  // At most 2^31 words of 16 bits: the sum stays far below 2^53.
  let sum = 0;
  const even = file.length - (file.length % 2);
  for (let offset = 0; offset < even; offset += 2)
    if (offset !== checksumOffset && offset !== checksumOffset + 2)
      sum += file.readUInt16LE(offset);
  if (even !== file.length) sum += file[file.length - 1];
  while (sum > 0xffff) sum = (sum % 0x10000) + Math.floor(sum / 0x10000);
  return (sum + file.length) >>> 0;
}

/**
 * Embedded PyInstaller archive of `file`: a data area, the table of contents and the
 * cookie at the very end of the file. Throws for any other layout.
 */
export function readKimiArchive(file) {
  const image = readImage(file);
  const cookie = file.length - COOKIE_LENGTH;
  if (
    cookie < image.end ||
    !file.subarray(cookie, cookie + COOKIE_MAGIC.length).equals(COOKIE_MAGIC)
  )
    throw invalid("no archive cookie at the end of the file");
  const packageLength = file.readUInt32BE(cookie + 8);
  const tocOffset = file.readUInt32BE(cookie + 12);
  const tocLength = file.readUInt32BE(cookie + 16);
  const start = file.length - packageLength;
  if (
    start < image.end ||
    tocOffset + tocLength + COOKIE_LENGTH !== packageLength
  )
    throw invalid("archive lengths do not describe this file");
  const entries = [];
  const tocEnd = start + tocOffset + tocLength;
  for (let at = start + tocOffset; at < tocEnd;) {
    const length = at + 4 <= tocEnd ? file.readUInt32BE(at) : 0;
    if (length <= ENTRY_HEADER_LENGTH || at + length > tocEnd)
      throw invalid("table of contents entry is malformed");
    const name = file.subarray(at + ENTRY_HEADER_LENGTH, at + length);
    const terminator = name.indexOf(0);
    if (terminator < 0) throw invalid("table of contents name is unterminated");
    entries.push({
      type: String.fromCharCode(file[at + 17]),
      name: name.subarray(0, terminator).toString("utf8"),
    });
    at += length;
  }
  return { ...image, cookie, packageLength, tocOffset, tocLength, entries };
}

/**
 * Bytes of `file` with the `X utf8=1` run-time option appended to the archive's table of
 * contents, the cookie lengths grown by the new entry and a valid PE checksum. Offsets of
 * existing entries are relative to the archive start, which does not move. Throws when the
 * file is not a one-file PyInstaller executable or already carries a utf8 option.
 */
export function patchKimiExecutable(file) {
  const archive = readKimiArchive(file);
  if (
    archive.entries.some(
      (entry) => entry.type === "o" && /^X utf8(?:[= ]|$)/.test(entry.name),
    )
  )
    throw new Error("Kimi executable already has a utf8 run-time option");
  const name = Buffer.from(`${KIMI_UTF8_OPTION}\0`, "latin1");
  // PyInstaller aligns entries to 16 bytes for bootloaders on strict-alignment platforms.
  const entry = Buffer.alloc(
    Math.ceil((ENTRY_HEADER_LENGTH + name.length) / 16) * 16,
  );
  entry.writeUInt32BE(entry.length, 0);
  // An option carries no data; like PyInstaller, point at the end of the data area.
  entry.writeUInt32BE(archive.tocOffset, 4);
  entry[17] = OPTION_TYPE;
  name.copy(entry, ENTRY_HEADER_LENGTH);
  const cookie = Buffer.from(file.subarray(archive.cookie));
  cookie.writeUInt32BE(archive.packageLength + entry.length, 8);
  cookie.writeUInt32BE(archive.tocLength + entry.length, 16);
  const patched = Buffer.concat([
    file.subarray(0, archive.cookie),
    entry,
    cookie,
  ]);
  patched.writeUInt32LE(
    peChecksum(patched, archive.checksumOffset),
    archive.checksumOffset,
  );
  return patched;
}

/**
 * Patch `file` in place (atomic replace). Idempotent: an already patched pinned file is
 * left as is. Fails for any file that is neither a pinned original nor its patched form.
 */
export async function prepareKimi(file) {
  const target = path.resolve(file);
  const bytes = await readFile(target);
  const digest = sha256(bytes);
  const pinned = Object.values(KIMI_EXECUTABLES);
  if (pinned.some((entry) => entry.patched === digest))
    return { id: "kimi", file: target, changed: false };
  const match = pinned.find((entry) => entry.original === digest);
  if (!match)
    throw new Error(
      `Unexpected Kimi executable ${target} (sha256 ${digest}); expected kimi-cli 1.50.0`,
    );
  const patched = patchKimiExecutable(bytes);
  if (sha256(patched) !== match.patched)
    throw new Error("Patched kimi.exe does not have the expected digest");
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, patched, { flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return { id: "kimi", file: target, changed: true };
}

/** Throw unless `file` is a pinned patched executable (used by `prepare-contest --check`). */
export async function verifyKimiPatch(file) {
  const digest = sha256(await readFile(path.resolve(file)));
  if (
    !Object.values(KIMI_EXECUTABLES).some((entry) => entry.patched === digest)
  )
    throw new Error(
      "Kimi executable lacks the UTF-8 run-time option; prepare into a fresh root",
    );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: { executable: { type: "string" } },
  });
  if (!values.executable) {
    console.error(
      "Usage: node scripts/prepare-kimi.mjs --executable ENGINES/kimi/kimi.exe",
    );
    process.exit(2);
  }
  console.log(JSON.stringify(await prepareKimi(values.executable)));
}
