import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { startHub } from "../../src/main.js";
import {
  BenchmarkRunner,
  parseDataset,
  prepareAttempts,
} from "../../src/benchmark/runner.js";
import {
  benchmarkHash,
  type BenchmarkTask,
} from "../../src/domain/benchmark.js";
import { SqliteBenchmarkStore } from "../../src/storage/benchmark-store.js";

const fixtureTask: BenchmarkTask = {
  id: "json",
  version: "1",
  fixtureFiles: [{ path: "inputs/source.json", text: '{"a":2,"b":3}\n' }],
  input: {
    text: "complete",
    timeoutMs: 5000,
    outputs: [
      { path: "result.json", name: "result.json" },
      { path: "summary.txt", name: "summary.txt" },
    ],
  },
  evaluator: {
    id: "json-equal",
    version: "1",
    expected: { sum: 5, values: [2, 3] },
    artifactName: "result.json",
  },
};

void test(
  "Benchmark file task verifies initial fixture hashes, binary bytes, missing outputs and offline regrade",
  { timeout: 20_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "harnesshub-benchmark-files-"),
    );
    let close = async () => {};
    t.after(async () => {
      await close();
      await rm(directory, { recursive: true, force: true });
    });
    const binary: BenchmarkTask = {
      ...fixtureTask,
      id: "binary",
      input: {
        ...fixtureTask.input,
        outputs: [{ path: "binary.dat", name: "binary.dat" }],
      },
      evaluator: {
        id: "file-sha256",
        version: "1",
        artifactName: "binary.dat",
        expected: benchmarkHash(Buffer.from([0, 255, 128, 10, 42])),
      },
    };
    const dataset = parseDataset({
      schemaVersion: 1,
      id: "files",
      version: "1",
      tasks: [
        fixtureTask,
        binary,
        {
          ...fixtureTask,
          id: "missing",
          input: {
            ...fixtureTask.input,
            outputs: [
              ...fixtureTask.input.outputs!,
              { path: "missing.txt", name: "missing.txt" },
            ],
          },
        },
        { ...fixtureTask, id: "modified-fixture" },
        { ...fixtureTask, id: "symlink-fixture" },
        { ...fixtureTask, id: "extra-file" },
      ],
    });
    const attempts = await prepareAttempts({
      dataDir: directory,
      dataset,
      engines: ["file-cli"],
      repeat: 1,
      hubVersion: "0.1.0",
    });
    const config = path.join(directory, "engines.json");
    const code = `const fs = require('node:fs'); const input=JSON.parse(fs.readFileSync('inputs/source.json','utf8')); fs.writeFileSync('result.json',JSON.stringify({values:[input.a,input.b],sum:input.a+input.b})); fs.writeFileSync('summary.txt','sum=5\\n'); fs.writeFileSync('binary.dat',Buffer.from([0,255,128,10,42])); process.stdout.write('done');`;
    await writeFile(
      config,
      JSON.stringify({
        engines: [
          {
            id: "file-cli",
            driver: "cli",
            command: [process.execPath, "-e", code],
          },
        ],
      }),
    );
    let hub = await startHub({
      dataDir: directory,
      demo: false,
      cwd: directory,
      port: 0,
      configFile: config,
      workspaces: attempts.map((attempt) => attempt.workspace),
    });
    let store = new SqliteBenchmarkStore(
      path.join(directory, "harnesshub.sqlite"),
    );
    close = async () => {
      store.close();
      await hub.server.close();
    };
    let runner = new BenchmarkRunner(hub.app, store);
    const results = [];
    for (const attempt of attempts) {
      if (attempt.task.id === "modified-fixture")
        await writeFile(
          path.join(attempt.workspace.path, "inputs/source.json"),
          '{"a":9,"b":3}\n',
        );
      if (attempt.task.id === "symlink-fixture") {
        const location = path.join(
          attempt.workspace.path,
          "inputs/source.json",
        );
        await rm(location);
        if (process.platform === "win32") {
          await rmdir(path.dirname(location));
          await symlink(
            path.join(attempts[0]!.workspace.path, "inputs"),
            path.dirname(location),
            "junction",
          );
        } else {
          await symlink(
            path.join(attempts[0]!.workspace.path, "inputs/source.json"),
            location,
            "file",
          );
        }
      }
      if (attempt.task.id === "extra-file")
        await writeFile(
          path.join(attempt.workspace.path, "foreign.txt"),
          "pollution",
        );
      results.push(await runner.execute(attempt));
    }
    assert.deepEqual(
      results.map((result) => result.status),
      [
        "passed",
        "passed",
        "failed",
        "execution_failed",
        "execution_failed",
        "execution_failed",
      ],
    );
    assert.equal(results[2]?.reason, "required_output_missing");
    assert.ok(
      results
        .slice(3)
        .every((result) => result.reason === "BENCHMARK_WORKSPACE_POLLUTED"),
    );
    const json = store.get(attempts[0]!.id);
    const raw = store.get(attempts[1]!.id);
    assert.equal(json.evidence?.requiredArtifacts?.length, 2);
    assert.equal(json.evidence?.size, Buffer.byteLength(json.evidence!.text!));
    assert.equal(raw.evidence?.text, undefined);
    assert.deepEqual(
      Buffer.from(raw.evidence!.bytesBase64!, "base64"),
      Buffer.from([0, 255, 128, 10, 42]),
    );
    assert.equal(raw.evidence?.size, 5);
    assert.equal(store.get(attempts[2]!.id).runStatus, "completed");
    assert.ok(
      hub.app
        .events(store.get(attempts[2]!.id).runId!, 0, 100)
        .some((event) => event.type === "ARTIFACT_MISSING"),
    );
    const selected = hub.app
      .getRun(raw.runId!)
      .artifacts.find((artifact) => artifact.name === "binary.dat")!;
    const source = await hub.app.artifact(selected.id);
    await rm(source.record.path);
    await rm(raw.workspace.path, { recursive: true });
    store.close();
    await hub.server.close();
    hub = await startHub({
      dataDir: directory,
      demo: false,
      cwd: directory,
      port: 0,
      configFile: config,
    });
    store = new SqliteBenchmarkStore(path.join(directory, "harnesshub.sqlite"));
    runner = new BenchmarkRunner(hub.app, store);
    assert.equal(runner.regrade(raw.id).status, "passed");
    const database = new DatabaseSync(
      path.join(directory, "harnesshub.sqlite"),
    );
    try {
      const tampered = store.get(raw.id);
      tampered.evidence = {
        ...tampered.evidence!,
        bytesBase64: Buffer.from([1, 2, 3]).toString("base64"),
      };
      database
        .prepare("UPDATE benchmark_attempts SET record = ? WHERE id = ?")
        .run(JSON.stringify(tampered), raw.id);
      assert.equal(
        runner.regrade(raw.id).reason,
        "BENCHMARK_EVIDENCE_INTEGRITY",
      );
      // This remains the existing v1 database; optional record fields require no rewrite of historical data.
      assert.equal(
        database
          .prepare(
            "SELECT value FROM benchmark_metadata WHERE key='schema_version'",
          )
          .get()?.value,
        1,
      );
    } finally {
      database.close();
    }
  },
);

void test(
  "Benchmark explicitly resolves permissions with their actual once-option IDs and records applied decisions",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "harnesshub-benchmark-permissions-"),
    );
    let close = async () => {};
    t.after(async () => {
      await close();
      await rm(directory, { recursive: true, force: true });
    });
    const dataset = parseDataset({
      schemaVersion: 1,
      id: "permissions",
      version: "1",
      tasks: [
        {
          id: "permission",
          version: "1",
          input: {
            text: "granted",
            timeoutMs: 5000,
            fixture: { scenario: "permission" },
          },
          evaluator: { id: "text-exact", version: "1", expected: "granted" },
        },
      ],
    });
    const deny = (
      await prepareAttempts({
        dataDir: directory,
        dataset,
        engines: ["fake"],
        repeat: 1,
        hubVersion: "0.1.0",
      })
    )[0]!;
    const allow = (
      await prepareAttempts({
        dataDir: directory,
        dataset,
        engines: ["fake"],
        repeat: 1,
        hubVersion: "0.1.0",
        permissionPolicy: "allow-once",
      })
    )[0]!;
    const hub = await startHub({
      dataDir: directory,
      demo: true,
      cwd: directory,
      port: 0,
      workspaces: [deny.workspace, allow.workspace],
    });
    const store = new SqliteBenchmarkStore(
      path.join(directory, "harnesshub.sqlite"),
    );
    close = async () => {
      store.close();
      await hub.server.close();
    };
    const runner = new BenchmarkRunner(hub.app, store);
    assert.equal((await runner.execute(deny)).status, "execution_failed");
    assert.equal((await runner.execute(allow)).status, "passed");
    assert.equal(
      store.get(deny.id).runStatus,
      "failed",
      "default deny must not wait for timeout",
    );
    for (const attempt of [deny, allow]) {
      const saved = store.get(attempt.id);
      const permission = hub.app.getRun(saved.runId!).permissions[0]!;
      assert.equal(permission.status, "applied");
      assert.equal(
        permission.decision,
        attempt === deny ? "fake-reject-once" : "fake-allow-once",
      );
      assert.equal(
        hub.app
          .events(saved.runId!, 0, 100)
          .filter((event) => event.type === "PERMISSION_DECIDED").length,
        1,
      );
      assert.equal(
        saved.observations?.permissions?.[0]?.decision,
        permission.decision,
      );
    }
  },
);

void test(
  "Versioned JSON evaluator accepts object-key reordering and rejects invalid JSON or changed array order",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "harnesshub-benchmark-json-"),
    );
    let close = async () => {};
    t.after(async () => {
      await close();
      await rm(directory, { recursive: true, force: true });
    });
    const tasks = [
      '{ "b":[1,2], "a":true }',
      '{"a":true,"b":[2,1]}',
      "{broken",
    ].map((text, index) => ({
      id: `json-${index}`,
      version: "1",
      input: { text, timeoutMs: 5000 },
      evaluator: {
        id: "json-equal",
        version: "1",
        expected: { a: true, b: [1, 2] },
      },
    }));
    const attempts = await prepareAttempts({
      dataDir: directory,
      dataset: parseDataset({
        schemaVersion: 1,
        id: "json",
        version: "1",
        tasks,
      }),
      engines: ["fake"],
      repeat: 1,
      hubVersion: "0.1.0",
    });
    const hub = await startHub({
      dataDir: directory,
      demo: true,
      cwd: directory,
      port: 0,
      workspaces: attempts.map((attempt) => attempt.workspace),
    });
    const store = new SqliteBenchmarkStore(
      path.join(directory, "harnesshub.sqlite"),
    );
    close = async () => {
      store.close();
      await hub.server.close();
    };
    const runner = new BenchmarkRunner(hub.app, store);
    const results = [];
    for (const attempt of attempts) results.push(await runner.execute(attempt));
    assert.deepEqual(
      results.map((result) => result.reason),
      ["json_match", "json_mismatch", "invalid_json"],
    );
  },
);

void test("Fixture validation rejects host paths, aliases, unsupported binary hashes and input/output overlap before creating attempts", async () => {
  const dataset = {
    schemaVersion: 1,
    id: "invalid",
    version: "1",
    tasks: [fixtureTask],
  };
  for (const name of [
    "../escape",
    "/absolute",
    "C:/escape",
    "folder\\escape",
    "NUL",
    "trailing.",
    "a//b",
  ]) {
    assert.throws(
      () =>
        parseDataset({
          ...dataset,
          tasks: [
            { ...fixtureTask, fixtureFiles: [{ path: name, text: "x" }] },
          ],
        }),
      /safe portable/,
    );
  }
  assert.throws(
    () =>
      parseDataset({
        ...dataset,
        tasks: [
          {
            ...fixtureTask,
            fixtureFiles: [
              { path: "a", text: "x" },
              { path: "A", text: "y" },
            ],
          },
        ],
      }),
    /overlap or alias/,
  );
  assert.throws(
    () =>
      parseDataset({
        ...dataset,
        tasks: [
          {
            ...fixtureTask,
            fixtureFiles: [{ path: "result.json", text: "already correct" }],
          },
        ],
      }),
    /must not overwrite/,
  );
  assert.throws(
    () =>
      parseDataset({
        ...dataset,
        tasks: [
          {
            ...fixtureTask,
            evaluator: {
              id: "file-sha256",
              version: "1",
              expected: "wrong",
              artifactName: "output",
            },
          },
        ],
      }),
    /supported evaluators/,
  );
  parseDataset(
    JSON.parse(
      await readFile("examples/benchmark-files.json", "utf8"),
    ) as unknown,
  );
});
