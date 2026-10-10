import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { unpackManagementArchive } from "../../src/infrastructure/management/archive.js";
import { ManagementError, type ManagementInstallContext } from "../../src/contracts/management.js";

function tarEntry(name: string, data = Buffer.from("fixture"), type = "0", link = ""): Buffer {
  const header = Buffer.alloc(512); header.write(name, 0, 100); header.write("0000755\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136); header.fill(32, 148, 156); header.write(type, 156); header.write(link, 157, 100);
  header.write("ustar\0", 257); header.write("00", 263);
  const sum = header.reduce((total, byte) => total + byte, 0); header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const padding = Buffer.alloc((512 - data.length % 512) % 512); return Buffer.concat([header, data, padding]);
}
function crc32(bytes: Buffer): number { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }
function zip(entries: readonly { name: string; data: Buffer; mode?: number }[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), local = Buffer.alloc(30), directory = Buffer.alloc(46), crc = crc32(entry.data);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(entry.data.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE((3 << 8) | 20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(entry.data.length, 20); directory.writeUInt32LE(entry.data.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((entry.mode ?? 0o100755) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    const chunk = Buffer.concat([local, name, entry.data]); locals.push(chunk); central.push(Buffer.concat([directory, name])); offset += chunk.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, index, end]);
}
async function fixture(fn: (root: string, context: ManagementInstallContext) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-management-archive-"))), controller = new AbortController();
  try { await fn(root, { stage: root, signal: controller.signal, assertOwned: () => {}, log: () => {} }); } finally { controller.abort(); await rm(root, { recursive: true, force: true }); }
}
test("management tar/gzip extraction preserves a normal executable and an internal link", async () => fixture(async (root, context) => {
  const archive = join(root, "safe.tgz"), target = join(root, "payload");
  await writeFile(archive, gzipSync(Buffer.concat([tarEntry("bin/tool"), tarEntry("bin/link", Buffer.alloc(0), "2", "tool"), Buffer.alloc(1024)])));
  await unpackManagementArchive(archive, target, "https://fixture.invalid/safe.tar.gz", context);
  assert.equal(await readFile(join(target, "bin", "link"), "utf8"), "fixture"); assert.equal(await realpath(join(target, "bin", "link")), join(target, "bin", "tool"));
}));
test("management tar policies reject traversal, absolute/link escape and special entries without an uncaught stream error", async () => fixture(async (root, context) => {
  for (const [index, entry] of [tarEntry("../escape"), tarEntry("/absolute"), tarEntry("link", Buffer.alloc(0), "2", "../../escape"), tarEntry("pipe", Buffer.alloc(0), "6")].entries()) {
    const archive = join(root, "bad-" + index + ".tgz"); await writeFile(archive, gzipSync(Buffer.concat([entry, Buffer.alloc(1024)])));
    await assert.rejects(unpackManagementArchive(archive, join(root, "payload-" + index), "https://fixture.invalid/a.tar.gz", context), error => error instanceof ManagementError && error.code === "UNSAFE_ARCHIVE");
  }
}));
test("management bzip2 extraction actually decodes the reviewed archive format", async () => fixture(async (root, context) => {
  const archive = join(root, "safe.tbz2");
  await writeFile(archive, Buffer.from("QlpoOTFBWSZTWUWyBysAAG37gMmAAAhAAOaAAEBzJZ5ACAggAFRCE0yMJtIY0aCSRADQDTEaV7xHIQc2IQiEmvNssLkCGBjyDxPYRw5AsnF2vxvImU0tczU49BrKNR8xEQDYu5IpwoSCLZA5WA==", "base64"));
  await unpackManagementArchive(archive, join(root, "payload"), "https://fixture.invalid/a.tar.bz2", context); assert.equal(await readFile(join(root, "payload", "bin", "tool"), "utf8"), "fixture");
}));
test("management ZIP verifies regular bytes/modes and permits an internal symlink without moving the installed tree", async () => fixture(async (root, context) => {
  const archive = join(root, "safe.zip"); await writeFile(archive, zip([{ name: "bin/tool", data: Buffer.from("zip-fixture") }, { name: "bin/link", data: Buffer.from("tool"), mode: 0o120777 }]));
  await unpackManagementArchive(archive, join(root, "payload"), "https://fixture.invalid/a.zip", context);
  assert.equal(await readFile(join(root, "payload", "bin", "link"), "utf8"), "zip-fixture"); assert.ok((await stat(join(root, "payload", "bin", "tool"))).mode & 0o111);
}));
test("management ZIP refuses unsafe names and links and fences ownership before extraction", async () => fixture(async (root, context) => {
  for (const [index, entry] of [{ name: "../escape", data: Buffer.from("bad") }, { name: "link", data: Buffer.from("../../escape"), mode: 0o120777 }].entries()) {
    const archive = join(root, "bad-" + index + ".zip"); await writeFile(archive, zip([entry]));
    await assert.rejects(unpackManagementArchive(archive, join(root, "payload-" + index), "https://fixture.invalid/a.zip", context));
  }
  await assert.rejects(unpackManagementArchive(join(root, "unused"), join(root, "never"), "https://fixture.invalid/a.zip", { ...context, assertOwned: () => { throw new ManagementError("OWNERSHIP_LOST", "test owner lost"); } }), error => error instanceof ManagementError && error.code === "OWNERSHIP_LOST");
}));
