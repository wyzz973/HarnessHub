import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { BundleManifest } from "../../src/distribution/types.js";
import { startHub } from "../../src/main.js";

async function fixture(
  directory: string,
): Promise<{ entry: string; manifest: BundleManifest }> {
  const original = new URL("../../src/release-main.js", import.meta.url);
  // Exercise the compiled entry's real argv/catch/exit handling in a tiny bundle.
  // Relocate imports to the existing build; no runtime archive or model executable is needed.
  const compiled = (await readFile(original, "utf8")).replace(
    /from "(\.\/[^\"]+)"/g,
    (_match, specifier: string) =>
      `from ${JSON.stringify(new URL(specifier, original).href)}`,
  );
  const payload = new Map([
    ["dist/src/release-main.js", compiled],
    ["package.json", '{"type":"module"}\n'],
    ["runtime/node.exe", "fixture placeholder; never execute\n"],
    [
      "scripts/launch-engine.mjs",
      "throw new Error('configure/doctor must not launch a model');\n",
    ],
    ["console/server.js", "throw new Error('console is not requested');\n"],
    [
      "engines/fixture/peer.mjs",
      "throw new Error('model calls are not allowed by this test');\n",
    ],
  ]);
  for (const [name, bytes] of payload) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), bytes);
  }
  const manifest: BundleManifest = {
    schemaVersion: 1,
    platform: "win32",
    arch: process.arch as "arm64" | "x64",
    nodeVersion: process.versions.node,
    consoleEntry: "console/server.js",
    components: [],
    engines: [
      {
        id: "fixture",
        name: "Fixture",
        version: "1.0.0",
        driver: "acp",
        command: ["${node}", "${bundle}/engines/fixture/peer.mjs"],
        configuration: { adapter: "codex" },
        requiredFiles: ["engines/fixture/peer.mjs"],
      },
    ],
    files: [...payload].map(([name, bytes]) => ({
      path: name,
      size: Buffer.byteLength(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  await writeFile(
    path.join(directory, "bundle.json"),
    JSON.stringify(manifest),
  );
  return { entry: path.join(directory, "dist/src/release-main.js"), manifest };
}
async function cli(
  entry: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [entry, ...args], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill(), 20000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

void test(
  "release CLI validates settings before replacing usable state and reports configuration failures as nonzero",
  { skip: process.platform !== "win32", timeout: 60000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "hh-release-cli-")),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const { entry } = await fixture(root);
    const input = path.join(root, "candidate.json");
    const good = {
      schemaVersion: 1,
      defaultEngine: "fixture",
      engines: { fixture: { model: "judge-model" } },
    };
    await writeFile(input, JSON.stringify(good));
    const configured = await cli(entry, ["configure", "--file", input]);
    assert.equal(configured.code, 0, configured.stderr);
    const reported = JSON.parse(configured.stdout) as {
      configured: boolean;
      modelCalled: boolean;
    };
    assert.equal(reported.configured, true);
    assert.equal(reported.modelCalled, false);
    const settingsFile = path.join(root, "state/settings.json");
    const generatedFile = path.join(root, "state/engines.generated.json");
    const previous = await readFile(settingsFile);
    const previousGenerated = await readFile(generatedFile);
    const hub = await startHub({
      dataDir: path.join(root, "state/gateway-check"),
      configFile: generatedFile,
      cwd: path.join(root, "state/workspace"),
      demo: false,
      port: 0,
    });
    try {
      const response = await hub.server.inject({
        method: "GET",
        url: "/v1/engines",
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(response.body.includes("judge-model"));
    } finally {
      await hub.server.close();
    }
    for (const candidate of [
      { ...good, schemaVersion: 2 },
      { ...good, engines: { fixture: { enabled: false } } },
      { ...good, defaultEngine: "outside" },
      { ...good, engines: { fixture: { modelProfile: "missing" } } },
      {
        ...good,
        modelProfiles: {
          unused: {
            model: "judge",
            provider: {
              protocol: "openai-responses",
              apiKey: { kind: "file", value: "relative-secret" },
            },
          },
        },
      },
    ]) {
      await writeFile(input, JSON.stringify(candidate));
      const rejected = await cli(entry, ["configure", "--file", input]);
      assert.equal(
        rejected.code,
        1,
        `Expected nonzero for ${JSON.stringify(candidate)}: ${rejected.stdout} ${rejected.stderr}`,
      );
      assert.equal(rejected.stdout.includes('"configured":true'), false);
      assert.deepEqual(
        await readFile(settingsFile),
        previous,
        "a rejected configuration must preserve prior settings",
      );
      assert.deepEqual(
        await readFile(generatedFile),
        previousGenerated,
        "a rejected configuration must preserve usable generated config",
      );
    }
    const unknown = await cli(entry, ["unknown-command"]);
    assert.equal(unknown.code, 1);
  },
);

void test(
  "release CLI repairs corrupt settings and requires unuse before removing an installed selected Skill package",
  { skip: process.platform !== "win32", timeout: 60000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "hh-release-tools-")),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const { entry } = await fixture(root);
    await mkdir(path.join(root, "state"));
    const settingsFile = path.join(root, "state/settings.json");
    await writeFile(settingsFile, "{corrupt existing JSON");
    const input = path.join(root, "candidate.json");
    await writeFile(
      input,
      JSON.stringify({ schemaVersion: 1, defaultEngine: "fixture" }),
    );
    const repaired = await cli(entry, ["configure", "--file", input]);
    assert.equal(repaired.code, 0, repaired.stderr);
    assert.equal(
      (
        JSON.parse(await readFile(settingsFile, "utf8")) as {
          schemaVersion: number;
        }
      ).schemaVersion,
      1,
    );
    const source = fileURLToPath(
      new URL(
        "../../../examples/tool-packages/portable-review",
        import.meta.url,
      ),
    );
    const installed = await cli(entry, [
      "tools",
      "install",
      "--source",
      source,
    ]);
    assert.equal(installed.code, 0, installed.stderr);
    const use = [
      "tools",
      "use",
      "portable-review",
      "1.0.0",
      "--engine",
      "fixture",
    ];
    const selected = await cli(entry, use);
    assert.equal(selected.code, 0, selected.stderr);
    const before = await readFile(settingsFile);
    const repeated = await cli(entry, use);
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.deepEqual(await readFile(settingsFile), before);
    const remove = [
      "tools",
      "remove",
      "--id",
      "portable-review",
      "--version",
      "1.0.0",
    ];
    const rejected = await cli(entry, remove);
    assert.equal(rejected.code, 1, rejected.stdout);
    assert.match(rejected.stderr, /use|selected|bound|binding/i);
    assert.deepEqual(await readFile(settingsFile), before);
    const stillInstalled = await cli(entry, [
      "tools",
      "verify",
      "--id",
      "portable-review",
      "--version",
      "1.0.0",
    ]);
    assert.equal(stillInstalled.code, 0, stillInstalled.stderr);
    const unselected = await cli(entry, [
      "tools",
      "unuse",
      "--engine",
      "fixture",
      "--id",
      "portable-review",
      "--version",
      "1.0.0",
    ]);
    assert.equal(unselected.code, 0, unselected.stderr);
    const removed = await cli(entry, remove);
    assert.equal(removed.code, 0, removed.stderr);
    const generated = JSON.parse(
      await readFile(path.join(root, "state/engines.generated.json"), "utf8"),
    ) as { engines: { configuration?: { skills?: unknown[] } }[] };
    assert.equal(generated.engines[0]!.configuration?.skills?.length ?? 0, 0);
    const list = await cli(entry, ["tools", "list", "--include-removed"]);
    assert.equal(list.code, 0, list.stderr);
    assert.equal(
      (JSON.parse(list.stdout) as { status: string }[])[0]!.status,
      "removed",
    );
  },
);

void test(
  "release configure and tool selection reject existing console overrides without changing settings or generated configuration",
  { skip: process.platform !== "win32", timeout: 60000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "hh-release-overlay-")),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const { entry } = await fixture(root);
    const input = path.join(root, "candidate.json");
    await writeFile(
      input,
      JSON.stringify({ schemaVersion: 1, defaultEngine: "fixture" }),
    );
    assert.equal((await cli(entry, ["configure", "--file", input])).code, 0);
    const settingsFile = path.join(root, "state/settings.json");
    const generatedFile = path.join(root, "state/engines.generated.json");
    const hub = await startHub({
      dataDir: path.join(root, "state/data"),
      configFile: generatedFile,
      cwd: path.join(root, "state/workspace"),
      demo: false,
      port: 0,
    });
    try {
      const response = await fetch(`${hub.url}/v1/engines/fixture`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "fixture",
          driver: "acp",
          command: [process.execPath],
          model: "console-model",
        }),
      });
      assert.equal(response.status, 200, await response.text());
    } finally {
      await hub.server.close();
    }
    const installed = await cli(entry, [
      "tools",
      "install",
      "--source",
      fileURLToPath(
        new URL(
          "../../../examples/tool-packages/portable-review",
          import.meta.url,
        ),
      ),
    ]);
    assert.equal(installed.code, 0, installed.stderr);
    const oldSettings = await readFile(settingsFile);
    const oldGenerated = await readFile(generatedFile);
    await writeFile(
      input,
      JSON.stringify({
        schemaVersion: 1,
        defaultEngine: "fixture",
        engines: { fixture: { model: "file-model" } },
      }),
    );
    for (const args of [
      ["configure", "--file", input],
      ["tools", "use", "portable-review", "1.0.0", "--engine", "fixture"],
      [
        "tools",
        "unuse",
        "--id",
        "portable-review",
        "--version",
        "1.0.0",
        "--engine",
        "fixture",
      ],
    ]) {
      const result = await cli(entry, args);
      assert.equal(result.code, 1, `${result.stdout} ${result.stderr}`);
      assert.match(result.stderr, /console|override/i);
      assert.deepEqual(await readFile(settingsFile), oldSettings);
      assert.deepEqual(await readFile(generatedFile), oldGenerated);
    }
  },
);

void test(
  "release doctor distinguishes full hashes and fails on tampered bytes without model invocation",
  { skip: process.platform !== "win32", timeout: 30000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "hh-release-doctor-")),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const { entry, manifest } = await fixture(root);
    const checked = await cli(entry, ["doctor", "--full"]);
    assert.equal(checked.code, 0, checked.stderr);
    const body = JSON.parse(checked.stdout) as {
      modelCalled: boolean;
      integrity: { hashesVerified: boolean };
      protocolChecks: unknown[];
    };
    assert.equal(body.modelCalled, false);
    assert.equal(body.integrity.hashesVerified, true);
    assert.deepEqual(body.protocolChecks, []);
    const peer = path.join(root, "engines/fixture/peer.mjs");
    await writeFile(peer, Buffer.alloc((await readFile(peer)).length, 120));
    const tampered = await cli(entry, ["doctor", "--full"]);
    assert.equal(tampered.code, 1);
    assert.match(tampered.stderr, /hash|changed/i);
    await writeFile(
      path.join(root, "bundle.json"),
      JSON.stringify({ ...manifest, arch: [process.arch] }),
    );
    const malformed = await cli(entry, ["engines"]);
    assert.equal(malformed.code, 1);
  },
);
