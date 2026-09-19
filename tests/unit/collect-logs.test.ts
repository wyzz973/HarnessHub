import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { collectLogs } from "../../src/collect-logs-main.js";
import { createZip } from "../../src/logging/zip.js";

/** Minimal reader for the archives createZip writes: central directory + deflate. */
function readZip(archive: Buffer): Map<string, Buffer> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "end of central directory");
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50);
    assert.equal(
      archive.readUInt16LE(offset + 8) & 0x0800,
      0x0800,
      "UTF-8 flag",
    );
    const checksum = archive.readUInt32LE(offset + 16);
    const compressed = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const local = archive.readUInt32LE(offset + 42);
    const name = archive.toString(
      "utf8",
      offset + 46,
      offset + 46 + nameLength,
    );
    const localName = archive.readUInt16LE(local + 26);
    const start = local + 30 + localName + archive.readUInt16LE(local + 28);
    const data = inflateRawSync(archive.subarray(start, start + compressed));
    assert.equal(data.length, size);
    assert.equal(crc32(data), checksum);
    entries.set(name, data);
    offset += 46 + nameLength;
  }
  return entries;
}

void test("the ZIP writer produces verifiable deflate entries and rejects unsafe names", () => {
  const zip = createZip([
    { name: "a/日志.txt", data: Buffer.from("第一行\n".repeat(100)) },
    { name: "empty.log", data: Buffer.alloc(0) },
  ]);
  const entries = readZip(zip);
  assert.equal(entries.get("a/日志.txt")!.toString(), "第一行\n".repeat(100));
  assert.equal(entries.get("empty.log")!.length, 0);
  for (const name of ["../escape.log", "/absolute.log", ""])
    assert.throws(() => createZip([{ name, data: Buffer.alloc(1) }]));
  assert.throws(() =>
    createZip([
      { name: "same.log", data: Buffer.alloc(1) },
      { name: "same.log", data: Buffer.alloc(1) },
    ]),
  );
});

void test("Collect-Logs packs HarnessHub logs whole, engine logs as bounded tails, redacted", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hh-collect-logs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  const data = join(state, "competition-data");
  const secret = "company-model-key-0123456789";
  const write = (relative: string, text: string) => {
    const file = join(state, relative);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  };
  write(
    "competition-data/logs/gateway.log",
    `{"event":"http","note":"key ${secret}","auth":"Bearer abcdefghijklmnopq"}\n`,
  );
  write("competition-data/logs/gateway.log.1", '{"event":"gateway.start"}\n');
  write(
    "competition-data/backends/s1/diagnostics/engine.log",
    '{"event":"acp.turn"}\n',
  );
  write(
    "competition-data/backends/s1/diagnostics/worker-errors.log",
    "[2026] run=r1\nError: boom\n",
  );
  write(
    "competition-data/backends/s1/home/.local/share/opencode/log/opencode.log",
    `${"old line\n".repeat(1000)}recent tail with ${secret}\n`,
  );
  write("competition-data/backends/s1/home/config.json", '{"not":"a log"}');
  if (process.platform !== "win32") {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "leak.log"), "must not be followed");
    symlinkSync(outside, join(data, "linked"));
  }
  const out = join(root, "logs.zip");
  return collectLogs({
    root: state,
    out,
    nativeBytes: 64,
    env: { HARNESSHUB_MODEL_API_KEY: secret, PATH: "/bin" },
    now: new Date("2026-09-20T00:00:00Z"),
  }).then((result) => {
    assert.equal(result.out, out);
    const entries = readZip(readFileSync(out));
    const names = [...entries.keys()].sort();
    assert.deepEqual(names, [
      "engines/competition-data/backends/s1/home/.local/share/opencode/log/opencode.log",
      "harnesshub/competition-data/backends/s1/diagnostics/engine.log",
      "harnesshub/competition-data/backends/s1/diagnostics/worker-errors.log",
      "harnesshub/competition-data/logs/gateway.log",
      "harnesshub/competition-data/logs/gateway.log.1",
      "manifest.json",
    ]);
    const all = [...entries.values()].map((value) => value.toString("utf8"));
    assert.equal(
      all.some((text) => text.includes(secret)),
      false,
    );
    assert.equal(
      all.some((text) => text.includes("abcdefghijklmnopq")),
      false,
    );
    const gateway = entries
      .get("harnesshub/competition-data/logs/gateway.log")!
      .toString();
    assert.match(gateway, /key \[REDACTED\]/);
    const native = entries
      .get(
        "engines/competition-data/backends/s1/home/.local/share/opencode/log/opencode.log",
      )!
      .toString();
    assert.ok(native.length <= 64);
    assert.match(native, /recent tail with \[REDACTED\]/);
    const manifest = JSON.parse(entries.get("manifest.json")!.toString()) as {
      files: { path: string; kind: string; truncated: number }[];
    };
    const opencode = manifest.files.find((file) => file.kind === "engine")!;
    assert.ok(opencode.truncated > 0);
    assert.equal(
      manifest.files.filter((file) => file.kind === "harnesshub").length,
      4,
    );
  });
});
