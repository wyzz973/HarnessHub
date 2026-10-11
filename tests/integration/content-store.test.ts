import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionError } from "../../src/contracts/session.js";
import { CONTENT_RETENTION_MS, LocalContentStore } from "../../src/infrastructure/session/content-store.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
async function root(t: test.TestContext): Promise<string> { const path = await mkdtemp(join(tmpdir(), "harness-content-")); t.after(() => rm(path, { recursive: true, force: true })); return path; }
function code(expected: string) { return (error: unknown) => error instanceof SessionError && error.code === expected; }

test("native outputs are content-addressed, typed by their bytes and served from private files", async t => {
  const data = await root(t), store = new LocalContentStore(data, () => {});
  const image = await store.storeOutput({ workspace: "/w", name: "chart.png", mediaType: "image/png", data: PNG });
  const again = await store.storeOutput({ workspace: "/w", name: "same.png", mediaType: "image/png", data: PNG });
  assert.equal(image.kind, "image"); assert.equal(image.bytes, PNG.length); assert.notEqual(image.id, again.id); assert.equal(image.sha256, again.sha256);
  assert.equal((await readdir(join(data, "content", "blobs"))).length, 1, "identical bytes are stored once");
  const read = store.read(image.id);
  assert.deepEqual(read.ref, image); assert.equal(read.origin, "output"); assert.deepEqual(await readFile(read.path), PNG);
  assert.equal((await stat(read.path)).mode & 0o077, 0);
  // A mislabeled image is kept only as an opaque file and never rendered as an image.
  assert.equal((await store.storeOutput({ workspace: "/w", name: "fake.png", mediaType: "image/png", data: Buffer.from("<svg/>") })).kind, "file");
  assert.equal((await store.storeOutput({ workspace: "/w", name: "logo.svg", mediaType: "image/svg+xml", data: Buffer.from("<svg/>") })).kind, "file");
  for (const name of ["", "..", "a/b", "line\nbreak"]) await assert.rejects(store.storeOutput({ workspace: "/w", name, mediaType: "text/plain", data: Buffer.from("x") }), code("INVALID_INPUT"));
  await assert.rejects(store.storeOutput({ workspace: "/w", name: "empty.txt", mediaType: "text/plain", data: Buffer.alloc(0) }), code("OUTPUT_LIMIT"));
  assert.throws(() => store.read("content-missing"), code("CONTENT_NOT_FOUND"));
});

test("collection keeps referenced and recent content and removes only unreferenced old records and blobs", async t => {
  const data = await root(t); let now = Date.parse("2026-10-11T00:00:00Z");
  const store = new LocalContentStore(data, () => {}, () => now);
  const kept = await store.storeOutput({ workspace: "/w", name: "kept.txt", mediaType: "text/plain", data: Buffer.from("kept") });
  const orphan = await store.storeOutput({ workspace: "/w", name: "orphan.txt", mediaType: "text/plain", data: Buffer.from("orphan") });
  // An interrupted write leaves a partial file; it is collected only after its own age passes the partial window.
  await writeFile(join(data, "content", "partial", "stale"), "x", { mode: 0o600 });
  now += CONTENT_RETENTION_MS + 1;
  const later = new LocalContentStore(data, () => {}, () => now);
  const recent = await later.storeOutput({ workspace: "/w", name: "recent.txt", mediaType: "text/plain", data: Buffer.from("recent") });
  assert.deepEqual(later.collect(new Set([kept.id])), { records: 1, blobs: 1, partial: 1 });
  assert.deepEqual(later.read(kept.id).ref, kept); assert.throws(() => later.read(orphan.id), code("CONTENT_NOT_FOUND"));
  assert.equal(later.read(recent.id).ref.id, recent.id, "unreferenced content inside the retention window stays");
});

test("content storage fails closed on a foreign marker, unexpected files or an inactive owner", async t => {
  const data = await root(t); new LocalContentStore(data, () => {});
  await writeFile(join(data, "content", ".harness-gateway-content.json"), '{"application":"other"}\n', { mode: 0o600 });
  assert.throws(() => new LocalContentStore(data, () => {}), code("INVALID_STORAGE"));
  const second = await root(t); new LocalContentStore(second, () => {});
  await writeFile(join(second, "content", "blobs", "not-a-digest"), "x", { mode: 0o600 });
  assert.throws(() => new LocalContentStore(second, () => {}), code("INVALID_STORAGE"));
  const third = await root(t), owned = new LocalContentStore(third, () => {});
  let active = true; const guarded = new LocalContentStore(third, () => { if (!active) throw new SessionError("OWNER_LOST", "owner ended"); });
  active = false; await assert.rejects(guarded.storeOutput({ workspace: "/w", name: "late.txt", mediaType: "text/plain", data: Buffer.from("late") }), code("OWNER_LOST"));
  assert.equal((await owned.storeOutput({ workspace: "/w", name: "ok.txt", mediaType: "text/plain", data: Buffer.from("ok") })).kind, "file");
});
