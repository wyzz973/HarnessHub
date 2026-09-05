import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  rename,
  symlink,
  link,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createFileArtifactCollector } from "../../src/artifacts/collector.js";
import {
  createArtifactPublisher,
  discardArtifacts,
  readArtifact,
} from "../../src/artifacts/publisher.js";
import { HubError } from "../../src/domain/errors.js";
import type { EngineProfile, FileOutput } from "../../src/domain/types.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

const engine: EngineProfile = {
  id: "artifact-test",
  driver: "fake",
  revision: "v1",
  enabled: true,
  maxConcurrency: 1,
  capabilities: { resume: false, permissions: false, images: false },
};

async function fixture(t: TestContext) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "harnesshub-file-artifacts-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  const root = join(directory, "artifacts");
  await mkdir(workspace);
  const database = join(directory, "state.sqlite");
  const store = new SqliteStore(database);
  t.after(() => store.close());
  const session = store.createSession(engine, {
    id: "workspace",
    path: workspace,
  });
  const run = store.acceptRun(session.id, {
    text: "write files",
    timeoutMs: 60_000,
  }).run;
  const collect = createFileArtifactCollector(root);
  const signal = new AbortController().signal;
  return { directory, workspace, root, database, store, run, collect, signal };
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof HubError && error.code === code;
}

void test("binary and text output snapshots survive source mutation and SQLite reopen", async (t) => {
  const { workspace, root, database, store, run, collect, signal } =
    await fixture(t);
  const binary = Buffer.from([0, 255, 128, 13, 10, 127, 1]);
  await mkdir(join(workspace, "nested"));
  await writeFile(join(workspace, "nested", "result.bin"), binary);
  await writeFile(join(workspace, "report.json"), '{"ok":true}\n');
  const result = await collect(
    run.id,
    workspace,
    [
      { path: "nested/result.bin", name: "result.bin" },
      { path: "report.json", name: "report.json" },
    ],
    signal,
  );
  assert.deepEqual(result.missing, []);
  assert.equal(result.artifacts.length, 2);
  const artifact = result.artifacts[0];
  assert.ok(artifact);
  assert.equal(artifact.mediaType, "application/octet-stream");
  assert.equal(artifact.size, binary.length);
  assert.equal(
    artifact.sha256,
    createHash("sha256").update(binary).digest("hex"),
  );
  assert.equal(result.artifacts[1]?.mediaType, "application/json");
  for (const item of result.artifacts) store.registerArtifact(item);
  await writeFile(join(workspace, "nested", "result.bin"), "later contents");
  store.close();
  const reopened = new SqliteStore(database);
  t.after(() => reopened.close());
  assert.deepEqual(
    await readArtifact(root, reopened.getArtifact(artifact.id)),
    binary,
  );
  assert.equal(
    reopened.events(run.id).filter((event) => event.type === "ARTIFACT_CREATED")
      .length,
    2,
  );
  await writeFile(artifact.path, Buffer.alloc(binary.length, 9));
  await assert.rejects(
    readArtifact(root, artifact),
    hasCode("ARTIFACT_CORRUPT"),
  );
});

void test("missing files are explicit while undeclared files are never collected", async (t) => {
  const { workspace, run, collect, signal } = await fixture(t);
  await writeFile(join(workspace, "undeclared.txt"), "unrelated private data");
  const result = await collect(
    run.id,
    workspace,
    [
      { path: "missing.txt", name: "missing.txt" },
      { path: "missing-directory/result.txt", name: "result.txt" },
    ],
    signal,
  );
  assert.deepEqual(result, {
    artifacts: [],
    missing: ["missing.txt", "result.txt"],
  });
});

void test("absolute paths, traversal, duplicate names and incompatible file names fail before publication", async (t) => {
  const { workspace, root, run, collect, signal } = await fixture(t);
  const invalid: FileOutput[][] = [
    [{ path: "../secret.txt", name: "result.txt" }],
    [{ path: "/etc/passwd", name: "result.txt" }],
    [{ path: "C:/secret.txt", name: "result.txt" }],
    [{ path: "directory\\secret.txt", name: "result.txt" }],
    [{ path: "directory/./secret.txt", name: "result.txt" }],
    [{ path: "file.txt", name: "../result.txt" }],
    [
      { path: "a", name: "same" },
      { path: "b", name: "same" },
    ],
    [
      { path: "a", name: "one" },
      { path: "a", name: "two" },
    ],
    Array.from({ length: 33 }, (_, i) => ({
      path: `${i}.txt`,
      name: `${i}.txt`,
    })),
  ];
  for (const outputs of invalid)
    await assert.rejects(
      collect(run.id, workspace, outputs, signal),
      hasCode("INVALID_ARTIFACT_PATH"),
    );
  await assert.rejects(
    readdir(root),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "ENOENT",
  );
});

void test("leaf and ancestor symlinks, directories and hard links cannot become artifacts", async (t) => {
  const { directory, workspace, run, collect, signal } = await fixture(t);
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "outside data");
  await symlink(join(outside, "secret.txt"), join(workspace, "leaf.txt"));
  await symlink(outside, join(workspace, "linked-directory"));
  await mkdir(join(workspace, "directory"));
  await link(join(outside, "secret.txt"), join(workspace, "hard-link.txt"));
  for (const relative of ["leaf.txt", "linked-directory/secret.txt"])
    await assert.rejects(
      collect(run.id, workspace, [{ path: relative, name: "result" }], signal),
      hasCode("INVALID_ARTIFACT_PATH"),
    );
  for (const relative of ["directory", "hard-link.txt"])
    await assert.rejects(
      collect(run.id, workspace, [{ path: relative, name: "result" }], signal),
      hasCode("ARTIFACT_NOT_REGULAR"),
    );
  assert.equal(
    await readFile(join(outside, "secret.txt"), "utf8"),
    "outside data",
  );
  await rename(workspace, `${workspace}-original`);
  await symlink(outside, workspace);
  await assert.rejects(
    collect(
      run.id,
      workspace,
      [{ path: "secret.txt", name: "result" }],
      signal,
    ),
    hasCode("INVALID_ARTIFACT_PATH"),
  );
});

void test("an oversized output rolls back earlier unpublished files", async (t) => {
  const { workspace, root, run, collect, signal, store } = await fixture(t);
  await writeFile(join(workspace, "first.txt"), "valid");
  await writeFile(join(workspace, "huge.bin"), "");
  await truncate(join(workspace, "huge.bin"), 16 * 1024 * 1024 + 1);
  await assert.rejects(
    collect(
      run.id,
      workspace,
      [
        { path: "first.txt", name: "first.txt" },
        { path: "huge.bin", name: "huge.bin" },
      ],
      signal,
    ),
    hasCode("ARTIFACT_TOO_LARGE"),
  );
  assert.deepEqual(await readdir(join(root, run.id)), []);
  assert.deepEqual(store.listArtifacts(run.id), []);
});

void test("64 MiB aggregate limit is enforced across individually valid files", async (t) => {
  const { workspace, root, run, collect, signal } = await fixture(t);
  const outputs = Array.from({ length: 5 }, (_, i) => ({
    path: `${i}.bin`,
    name: `${i}.bin`,
  }));
  for (const [i, output] of outputs.entries()) {
    await writeFile(join(workspace, output.path), "");
    await truncate(
      join(workspace, output.path),
      i === 4 ? 1 : 16 * 1024 * 1024,
    );
  }
  await assert.rejects(
    collect(run.id, workspace, outputs, signal),
    hasCode("ARTIFACT_TOO_LARGE"),
  );
  assert.deepEqual(await readdir(join(root, run.id)), []);
});

void test("abort prevents publication; unregistered successful results can be discarded", async (t) => {
  const { workspace, root, run, collect, signal } = await fixture(t);
  await writeFile(join(workspace, "result.txt"), "hello");
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    collect(
      run.id,
      workspace,
      [{ path: "result.txt", name: "result.txt" }],
      abort.signal,
    ),
    { name: "AbortError" },
  );
  const result = await collect(
    run.id,
    workspace,
    [{ path: "result.txt", name: "result.txt", mediaType: "text/markdown" }],
    signal,
  );
  assert.equal(result.artifacts[0]?.mediaType, "text/markdown");
  await discardArtifacts(root, result.artifacts);
  await discardArtifacts(root, result.artifacts);
  assert.deepEqual(await readdir(join(root, run.id)), []);
});

void test("publisher and registered reader reject target symlinks and preserve legacy text delivery", async (t) => {
  const { directory, root, run } = await fixture(t);
  const publisher = createArtifactPublisher(root);
  const text = await publisher(run.id, {
    name: "legacy.txt",
    mediaType: "text/plain",
    text: "中文 old transport",
  });
  assert.equal(
    (await readArtifact(root, text)).toString(),
    "中文 old transport",
  );
  const outside = join(directory, "outside.txt");
  await writeFile(outside, "outside");
  await rm(text.path);
  await symlink(outside, text.path);
  await assert.rejects(
    readArtifact(root, text),
    hasCode("INVALID_ARTIFACT_PATH"),
  );
  await rm(text.path);
  await rmdir(join(root, run.id));
  const other = join(directory, "other");
  await mkdir(other);
  await symlink(other, join(root, run.id));
  await assert.rejects(
    publisher(run.id, {
      name: "later.txt",
      mediaType: "text/plain",
      text: "no",
    }),
    hasCode("INVALID_ARTIFACT_PATH"),
  );
  assert.deepEqual(await readdir(other), []);
});

void test("a concurrently changing output is rejected instead of publishing unstable bytes", async (t) => {
  const { workspace, run, collect, signal, store } = await fixture(t);
  const file = join(workspace, "changing.bin");
  await writeFile(file, Buffer.alloc(1024 * 1024));
  const descriptor = openSync(file, "r+");
  let pending: NodeJS.Immediate;
  let value = 0;
  const change = () => {
    writeSync(descriptor, Buffer.from([value++ % 256]), 0, 1, 0);
    pending = setImmediate(change);
  };
  change();
  t.after(() => {
    clearImmediate(pending);
    closeSync(descriptor);
  });
  await assert.rejects(
    collect(
      run.id,
      workspace,
      [{ path: "changing.bin", name: "changing.bin" }],
      signal,
    ),
    hasCode("ARTIFACT_CHANGED"),
  );
  clearImmediate(pending!);
  assert.deepEqual(store.listArtifacts(run.id), []);
});
