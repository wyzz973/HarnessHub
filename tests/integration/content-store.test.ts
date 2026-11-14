import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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
  // Its age is measured on this test's clock, not the computer's: once the real date passed the fixed one, a fresh mtime never aged.
  await writeFile(join(data, "content", "partial", "stale"), "x", { mode: 0o600 }); await utimes(join(data, "content", "partial", "stale"), new Date(now), new Date(now));
  now += CONTENT_RETENTION_MS + 1;
  const later = new LocalContentStore(data, () => {}, () => now);
  const recent = await later.storeOutput({ workspace: "/w", name: "recent.txt", mediaType: "text/plain", data: Buffer.from("recent") });
  assert.deepEqual(later.collect(new Set([kept.id])), { records: 1, blobs: 1, files: 0, partial: 1 });
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

async function* bytes(...parts: Uint8Array[]): AsyncIterable<Uint8Array> { for (const part of parts) yield part; }
test("uploads are staged once per command, typed by their bytes, admitted per workspace, withdrawn and copied read-only", async t => {
  const data = await root(t); let now = Date.parse("2026-10-11T00:00:00Z");
  const store = new LocalContentStore(data, () => {}, () => now);
  const stage = (key: string, name: string, type: string, body: Uint8Array, declared = body.byteLength) => store.stage({ workspace: "/w", name, mediaType: type, commandId: key, declaredBytes: declared, source: bytes(body) });
  const image = await stage("up-1", "shot.png", "image/png; charset=binary", PNG);
  assert.equal(image.kind, "image"); assert.equal(image.mediaType, "image/png");
  assert.deepEqual(await stage("up-1", "shot.png", "image/png", PNG), image, "a retried upload command returns the same reference");
  await assert.rejects(stage("up-1", "shot.png", "image/png", Buffer.concat([PNG, Buffer.from([9])])), code("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(stage("up-2", "fake.png", "image/png", Buffer.from("<svg/>")), code("INVALID_INPUT"));
  await assert.rejects(stage("up-3", "short.txt", "text/plain", Buffer.from("abc"), 4), code("INVALID_INPUT"));
  await assert.rejects(stage("up-4", "long.txt", "text/plain", Buffer.from("abcd"), 3), code("CONTENT_LIMIT"));
  assert.equal((await readdir(join(data, "content", "partial"))).length, 0, "rejected uploads leave no partial files");
  const notes = await stage("up-5", "notes.txt", "text/plain", Buffer.from("hello"));
  assert.deepEqual(store.resolve([image.id, notes.id]), [image, notes]);
  assert.throws(() => store.resolve(["content-unknown"]), code("ATTACHMENT_UNAVAILABLE"));
  assert.throws(() => store.resolve([image.id, image.id]), code("INVALID_INPUT"));
  const output = await store.storeOutput({ workspace: "/w", name: "out.txt", mediaType: "text/plain", data: Buffer.from("x") });
  assert.throws(() => store.resolve([output.id]), code("ATTACHMENT_UNAVAILABLE"), "native outputs are not user attachments");
  // A stable private copy: the same path every Turn, read-only, and repaired if something changed it.
  const [copy] = await store.materialize([image]);
  assert.equal(copy!.path, join(realpathSync(data), "content", "files", image.id, "shot.png"));
  assert.deepEqual(await readFile(copy!.path), PNG); assert.equal((await stat(copy!.path)).mode & 0o777, 0o400);
  await chmod(copy!.path, 0o600); await writeFile(copy!.path, "tampered");
  const [again] = await store.materialize([image]);
  assert.equal(again!.path, copy!.path); assert.deepEqual(await readFile(again!.path), PNG);
  store.discard(notes.id);
  assert.throws(() => store.resolve([notes.id]), code("ATTACHMENT_UNAVAILABLE"));
  assert.throws(() => store.discard(output.id), code("ATTACHMENT_UNAVAILABLE"), "a native output is not removed as an upload");
  // Withdrawn and unreferenced uploads go at the next owner start; a referenced upload and its copy stay.
  now += CONTENT_RETENTION_MS + 1;
  const later = new LocalContentStore(data, () => {}, () => now);
  assert.deepEqual(later.collect(new Set([image.id])), { records: 2, blobs: 2, files: 0, partial: 0 });
  assert.deepEqual(await readFile(copy!.path), PNG);
  assert.deepEqual(later.collect(new Set()), { records: 1, blobs: 1, files: 1, partial: 0 });
  assert.equal((await readdir(join(data, "content", "files"))).length, 0);
});

test("what a Harness made is kept whole, of any size, written as it comes; an upload still has its bounds", async t => {
  const data = await root(t), store = new LocalContentStore(data, () => {});
  const piece = Buffer.alloc(9 * 1024 * 1024, "a");
  // Three pieces of 9 MiB, never joined into one buffer by the store's caller.
  const ref = await store.storeOutput({ workspace: "/w", name: "big.json", mediaType: "application/json", data: [piece, Buffer.alloc(9 * 1024 * 1024, "b"), Buffer.alloc(9 * 1024 * 1024, "c")] });
  assert.equal(ref.bytes, 27 * 1024 * 1024);
  assert.equal(createHash("sha256").update(piece).update(Buffer.alloc(9 * 1024 * 1024, "b")).update(Buffer.alloc(9 * 1024 * 1024, "c")).digest("hex"), ref.sha256);
  const read = store.read(ref.id);
  assert.deepEqual(read.ref, ref); assert.equal((await stat(read.path)).size, ref.bytes);
  const text = await store.readText(ref, 64 * 1024 * 1024);
  assert.equal(text?.length, ref.bytes); assert.equal(text?.[0], "a"); assert.equal(text?.at(-1), "c");
  // From a source that makes the pieces as it is read.
  async function* made() { for (let n = 0; n < 5; n++) yield Buffer.from("x".repeat(5 * 1024 * 1024) + n); }
  const second = await store.storeOutput({ workspace: "/w", name: "made.json", mediaType: "application/json", data: made() });
  assert.equal(second.bytes, 5 * (5 * 1024 * 1024 + 1));
  assert.equal(store.read(second.id).ref.id, second.id, "and a record of that size is read back");
  // Nothing of nothing; a source that fails midway leaves no record and no partial file.
  await assert.rejects(store.storeOutput({ workspace: "/w", name: "none.json", mediaType: "application/json", data: [] }), code("OUTPUT_LIMIT"));
  async function* broken() { yield Buffer.from("half of it"); throw new Error("the disk filled up"); }
  await assert.rejects(store.storeOutput({ workspace: "/w", name: "broken.json", mediaType: "application/json", data: broken() }), /the disk filled up/u);
  assert.deepEqual(await readdir(join(data, "content", "partial")), [], "no partial file is left");
  assert.equal(store.collect(new Set([ref.id, second.id])).records, 0, "nothing else was recorded");
  // An upload is refused above what an upload may hold, as it always was.
  async function* body(size: number) { yield Buffer.alloc(size, "u"); }
  await assert.rejects(store.stage({ workspace: "/w", name: "up.bin", mediaType: "application/octet-stream", commandId: "up-big", declaredBytes: 1024 * 1024 * 1024 + 1, source: body(1) }), code("ATTACHMENT_LIMIT"));
});

test("the store holds no total of its own: more records than it once allowed do not stop an output from being kept", async t => {
  const data = await root(t), store = new LocalContentStore(data, () => {});
  const database = new DatabaseSync(join(data, "content", "content.sqlite"));
  try {
    database.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<262200)
      INSERT INTO content(id,sha256,name,media_type,kind,bytes,origin,workspace,command_id,fingerprint,created_at,discarded) SELECT 'content-fill-'||i, printf('%064x', i), 'f.txt', 'text/plain', 'file', 1, 'output', '/w', NULL, NULL, 0, 0 FROM n`);
    assert.equal(Number(database.prepare("SELECT COUNT(*) AS n FROM content").get()!.n), 262200);
  } finally { database.close(); }
  const ref = await store.storeOutput({ workspace: "/w", name: "after.json", mediaType: "application/json", data: Buffer.from("{}") });
  assert.equal(store.read(ref.id).ref.id, ref.id);
});
