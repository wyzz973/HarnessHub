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
  const stores: SqliteStore[] = [];
  const cleanup: (() => void)[] = [];
  t.after(async () => {
    for (const close of cleanup) close();
    for (const entry of stores) entry.close();
    await rm(directory, { recursive: true, force: true });
  });
  const workspace = join(directory, "workspace");
  const root = join(directory, "artifacts");
  await mkdir(workspace);
  const database = join(directory, "state.sqlite");
  const store = new SqliteStore(database);
  stores.push(store);
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
  return {
    directory,
    workspace,
    root,
    database,
    store,
    stores,
    cleanup,
    run,
    collect,
    signal,
  };
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof HubError && error.code === code;
}

void test("binary and text output snapshots survive source mutation and SQLite reopen", async (t) => {
  const { workspace, root, database, store, stores, run, collect, signal } =
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
  stores.push(reopened);
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

void test(
  "Windows drive and directory case aliases retain artifact identity",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { workspace, root, run, signal } = await fixture(t);
    await writeFile(join(workspace, "result.txt"), "case-stable bytes");
    const collect = createFileArtifactCollector(root.toLowerCase());
    const result = await collect(
      run.id,
      workspace.toLowerCase(),
      [{ path: "result.txt", name: "result.txt" }],
      signal,
    );
    assert.equal(result.artifacts.length, 1);
    const artifact = result.artifacts[0]!;
    assert.equal(
      (
        await readArtifact(root.toUpperCase(), {
          ...artifact,
          path: artifact.path.toUpperCase(),
        })
      ).toString(),
      "case-stable bytes",
    );
    await assert.rejects(
      readArtifact(root, {
        ...artifact,
        path: join(root, "foreign", artifact.id),
      }),
      hasCode("INVALID_ARTIFACT_PATH"),
    );
  },
);

void test(
  "Windows source and published paths can exceed MAX_PATH",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { directory, workspace, run, signal } = await fixture(t);
    const relative = Array.from(
      { length: 5 },
      (_, i) => `${i}-${"目录".repeat(22)}`,
    ).join("/");
    await mkdir(join(workspace, relative), { recursive: true });
    await writeFile(
      join(workspace, relative, "result.txt"),
      "long path snapshot",
    );
    const parent = join(directory, relative);
    await mkdir(parent, { recursive: true });
    const root = join(parent, "artifacts");
    assert.ok(root.length > 260);
    const result = await createFileArtifactCollector(root)(
      run.id,
      workspace,
      [{ path: `${relative}/result.txt`, name: "result.txt" }],
      signal,
    );
    assert.equal(
      (await readArtifact(root, result.artifacts[0]!)).toString(),
      "long path snapshot",
    );
  },
);

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

void test("ancestor links, directories and hard links cannot become artifacts", async (t) => {
  const { directory, workspace, run, collect, signal } = await fixture(t);
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "outside data");
  await symlink(
    outside,
    join(workspace, "linked-directory"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await mkdir(join(workspace, "directory"));
  await link(join(outside, "secret.txt"), join(workspace, "hard-link.txt"));
  for (const relative of ["linked-directory/secret.txt"])
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
  await symlink(
    outside,
    workspace,
    process.platform === "win32" ? "junction" : "dir",
  );
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

void test("leaf file symlinks cannot be collected or read as registered artifacts", async (t) => {
  const { directory, workspace, root, run, collect, signal } = await fixture(t);
  const outside = join(directory, "outside.txt");
  await writeFile(outside, "outside bytes");
  try {
    await symlink(outside, join(workspace, "leaf.txt"), "file");
  } catch (error) {
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      error.code === "EPERM"
    ) {
      t.skip(
        "File symlink creation needs Windows Developer Mode or SeCreateSymbolicLinkPrivilege; junction and hard-link rejection run independently",
      );
      return;
    }
    throw error;
  }
  await assert.rejects(
    collect(
      run.id,
      workspace,
      [{ path: "leaf.txt", name: "leaf.txt" }],
      signal,
    ),
    hasCode("INVALID_ARTIFACT_PATH"),
  );
  const record = await createArtifactPublisher(root)(run.id, {
    name: "registered.txt",
    mediaType: "text/plain",
    text: "registered bytes",
  });
  await rm(record.path);
  await symlink(outside, record.path, "file");
  await assert.rejects(
    readArtifact(root, record),
    hasCode("INVALID_ARTIFACT_PATH"),
  );
  assert.equal(await readFile(outside, "utf8"), "outside bytes");
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

void test("publisher rejects target directory links and preserves legacy text delivery", async (t) => {
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
  await rm(text.path);
  await rmdir(join(root, run.id));
  const other = join(directory, "other");
  await mkdir(other);
  await symlink(
    other,
    join(root, run.id),
    process.platform === "win32" ? "junction" : "dir",
  );
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
  const { workspace, run, collect, signal, store, cleanup } = await fixture(t);
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
  cleanup.push(() => {
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
