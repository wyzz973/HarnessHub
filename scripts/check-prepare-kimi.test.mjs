import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  KIMI_EXECUTABLE,
  KIMI_UTF8_OPTION,
  patchKimiExecutable,
  prepareKimi,
  readKimiArchive,
  verifyKimiPatch,
} from "./prepare-kimi.mjs";

const MAGIC = Buffer.from("4d45490c0b0a0b0e", "hex");

/** TOC entry the way PyInstaller's CArchive writer serializes it (16-byte aligned). */
function tocEntry(name, type, offset, length) {
  const bytes = Buffer.from(`${name}\0`, "utf8");
  const entry = Buffer.alloc(Math.ceil((18 + bytes.length) / 16) * 16);
  entry.writeUInt32BE(entry.length, 0);
  entry.writeUInt32BE(offset, 4);
  entry.writeUInt32BE(length, 8);
  entry.writeUInt32BE(length, 12);
  entry[17] = type.charCodeAt(0);
  bytes.copy(entry, 18);
  return entry;
}

/**
 * Minimal one-file layout: a PE image with one section, then the archive (data, table of
 * contents, cookie). `oddData` makes the file length odd like the pinned arm64 executable.
 */
function fixture({
  options = ["pyi-contents-directory _internal"],
  oddData = false,
} = {}) {
  const image = Buffer.alloc(0x400);
  image.writeUInt16LE(0x5a4d, 0);
  image.writeUInt32LE(0x80, 0x3c);
  image.writeUInt32LE(0x00004550, 0x80);
  image.writeUInt16LE(1, 0x80 + 6); // one section
  image.writeUInt16LE(240, 0x80 + 20); // optional header size (PE32+)
  const section = 0x80 + 24 + 240;
  image.write(".text", section, "latin1");
  image.writeUInt32LE(0x200, section + 16); // raw size
  image.writeUInt32LE(0x200, section + 20); // raw pointer: image ends at 0x400
  image.fill(0xc3, 0x200, 0x400);
  const data = Buffer.from(
    oddData ? "module bytes!" : "module bytes",
    "latin1",
  );
  const toc = Buffer.concat([
    tocEntry("struct", "m", 0, data.length),
    ...options.map((name) => tocEntry(name, "o", data.length, 0)),
  ]);
  const cookie = Buffer.alloc(88);
  MAGIC.copy(cookie, 0);
  cookie.writeUInt32BE(data.length + toc.length + 88, 8);
  cookie.writeUInt32BE(data.length, 12);
  cookie.writeUInt32BE(toc.length, 16);
  cookie.writeUInt32BE(314, 20);
  cookie.write("python314.dll", 24, "latin1");
  return Buffer.concat([image, data, toc, cookie]);
}

/** Independent reader: the steps of PyInstaller's bootloader (cookie at EOF, then the TOC). */
function bootloaderView(file) {
  const cookie = file.length - 88;
  assert.ok(file.subarray(cookie, cookie + 8).equals(MAGIC), "cookie at EOF");
  const packageLength = file.readUInt32BE(cookie + 8);
  const start = file.length - packageLength;
  const tocStart = start + file.readUInt32BE(cookie + 12);
  const tocEnd = tocStart + file.readUInt32BE(cookie + 16);
  assert.equal(tocEnd, cookie, "cookie follows the table of contents");
  const entries = [];
  for (let at = tocStart; at < tocEnd; at += file.readUInt32BE(at)) {
    const raw = file.subarray(at + 18, at + file.readUInt32BE(at));
    entries.push({
      length: file.readUInt32BE(at),
      offset: file.readUInt32BE(at + 4),
      size: file.readUInt32BE(at + 8),
      type: String.fromCharCode(file[at + 17]),
      name: raw.subarray(0, raw.indexOf(0)).toString("utf8"),
    });
  }
  return { start, entries };
}

/** imagehlp CheckSumMappedFile, written independently of the script under test. */
function checksum(file) {
  const field = file.readUInt32LE(0x3c) + 24 + 64;
  const copy = Buffer.concat([file, Buffer.alloc(file.length % 2)]);
  copy.writeUInt32LE(0, field);
  let sum = 0n;
  for (let at = 0; at < copy.length; at += 2)
    sum += BigInt(copy.readUInt16LE(at));
  while (sum >> 16n) sum = (sum & 0xffffn) + (sum >> 16n);
  return Number(sum) + file.length;
}

for (const oddData of [false, true])
  test(`the utf8 option is appended without moving archive data (${oddData ? "odd" : "even"} file length)`, () => {
    const original = fixture({ oddData });
    const patched = patchKimiExecutable(original);
    const before = bootloaderView(original);
    const after = bootloaderView(patched);
    assert.equal(after.start, before.start);
    assert.deepEqual(after.entries.slice(0, -1), before.entries);
    const added = after.entries.at(-1);
    assert.deepEqual(
      { type: added.type, name: added.name, size: added.size },
      { type: "o", name: KIMI_UTF8_OPTION, size: 0 },
    );
    assert.equal(added.length % 16, 0);
    assert.equal(patched.length, original.length + added.length);
    // Program bytes and archive data are untouched; only the checksum field differs.
    const field = original.readUInt32LE(0x3c) + 24 + 64;
    const comparable = (file) => {
      const copy = Buffer.from(file.subarray(0, original.length - 88));
      copy.writeUInt32LE(0, field);
      return copy;
    };
    assert.ok(comparable(patched).equals(comparable(original)));
    assert.equal(patched.readUInt32LE(field), checksum(patched));
    assert.deepEqual(
      readKimiArchive(patched).entries.map((entry) => entry.name),
      after.entries.map((entry) => entry.name),
    );
  });

test("an existing utf8 option and other file layouts are refused", () => {
  for (const name of ["X utf8=1", "X utf8", "X utf8=0"])
    assert.throws(
      () => patchKimiExecutable(fixture({ options: [name] })),
      /already has a utf8 run-time option/,
    );
  // A different X option is not a utf8 option.
  assert.doesNotThrow(() =>
    patchKimiExecutable(fixture({ options: ["X utf8mode"] })),
  );
  const valid = fixture();
  assert.throws(
    () => patchKimiExecutable(Buffer.from("not a program")),
    /missing MZ header/,
  );
  assert.throws(
    () => patchKimiExecutable(valid.subarray(0, valid.length - 1)),
    /no archive cookie at the end/,
  );
  const lengths = Buffer.from(valid);
  lengths.writeUInt32BE(
    lengths.readUInt32BE(lengths.length - 72) + 16,
    lengths.length - 72,
  );
  assert.throws(
    () => patchKimiExecutable(lengths),
    /archive lengths do not describe this file/,
  );
  const overlapping = Buffer.from(valid);
  overlapping.writeUInt32BE(valid.length, valid.length - 80);
  assert.throws(
    () => patchKimiExecutable(overlapping),
    /archive lengths do not describe this file/,
  );
  const entry = Buffer.from(valid);
  entry.writeUInt32BE(7, 0x400 + "module bytes".length);
  assert.throws(
    () => patchKimiExecutable(entry),
    /table of contents entry is malformed/,
  );
});

test("prepareKimi only accepts the pinned executables and never rewrites a foreign file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hh-kimi-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, KIMI_EXECUTABLE);
  await mkdir(path.dirname(file), { recursive: true });
  const foreign = fixture();
  await writeFile(file, foreign);
  await assert.rejects(prepareKimi(file), /expected kimi-cli 1\.50\.0/);
  assert.ok((await readFile(file)).equals(foreign));
  await assert.rejects(
    verifyKimiPatch(file),
    /lacks the UTF-8 run-time option/,
  );
  await rm(file);
  await assert.rejects(prepareKimi(file), { code: "ENOENT" });
});
