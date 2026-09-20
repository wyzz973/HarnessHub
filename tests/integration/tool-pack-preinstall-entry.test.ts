import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { BundleManifest } from "../../src/distribution/types.js";

const example = fileURLToPath(
  new URL("../../../examples/tool-packages/simple-toolkit", import.meta.url),
);
const PACK = "office-fixture";

/**
 * A tiny Windows bundle around the compiled competition entry, as release-cli.test.ts
 * builds one for hub.cmd: the entry's relative imports point at the real build, every
 * other payload file is a placeholder that is never executed, and the bundle lists one
 * preinstalled Tool Pack. The directory name has a space and non-ASCII characters.
 */
async function fixture(t: test.TestContext): Promise<{
  root: string;
  entry: string;
}> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "hh entry 预装-")),
  );
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }),
  );
  const original = new URL(
    "../../src/competition-bundle-main.js",
    import.meta.url,
  );
  const compiled = (await readFile(original, "utf8")).replace(
    /from "(\.\/[^"]+)"/g,
    (_match, specifier: string) =>
      `from ${JSON.stringify(new URL(specifier, original).href)}`,
  );
  const payload = new Map([
    ["dist/src/competition-bundle-main.js", compiled],
    [
      "dist/src/drivers/tool-command/command-mcp.js",
      "throw new Error('no Session runs in this test');\n",
    ],
    ["package.json", '{"type":"module"}\n'],
    ["runtime/node.exe", "fixture placeholder; never execute\n"],
    ["scripts/launch-engine.mjs", "throw new Error('never launched');\n"],
    ["console/server.js", "throw new Error('console is not requested');\n"],
    ["engines/fixture/peer.mjs", "throw new Error('never launched');\n"],
    [
      "tool-packs/preinstalled.json",
      `${JSON.stringify({ schemaVersion: 1, packs: [{ directory: PACK }] })}\r\n`,
    ],
  ]);
  for (const [name, bytes] of payload) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), bytes);
  }
  await cp(example, path.join(root, "tool-packs", PACK), { recursive: true });
  const files: BundleManifest["files"] = [];
  for (const entry of await readdir(root, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const bytes = await readFile(absolute);
    files.push({
      path: path.relative(root, absolute).split(path.sep).join("/"),
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
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
        configuration: { adapter: "generic" },
        requiredFiles: ["engines/fixture/peer.mjs"],
      },
    ],
    files,
  };
  await writeFile(path.join(root, "bundle.json"), JSON.stringify(manifest));
  return {
    root,
    entry: path.join(root, "dist", "src", "competition-bundle-main.js"),
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) =>
    server.listen({ port: 0, host: "127.0.0.1" }, resolve),
  );
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.ok(address && typeof address === "object");
  return address.port;
}

interface Started {
  child: ChildProcessByStdio<null, Readable, Readable>;
  url: string;
  stderr: () => string;
  stop: () => Promise<void>;
}

/** Start the entry and wait for its `competition.ready` line. */
async function start(
  entry: string,
  environment: NodeJS.ProcessEnv,
): Promise<Started> {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [entry, "--engine", "fixture", "--no-console", "--port", String(port)],
    { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  };
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no competition.ready line\n${stderr}`)),
        90_000,
      );
      child.once("error", reject);
      child.once("close", (code) =>
        reject(new Error(`entry exited with ${code}\n${stdout}\n${stderr}`)),
      );
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        for (const line of stdout.split(/\r?\n/)) {
          if (!line.includes('"competition.ready"')) continue;
          clearTimeout(timer);
          resolve((JSON.parse(line) as { url: string }).url);
        }
      });
    });
    return { child, url, stderr: () => stderr, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

void test(
  "the gateway.cmd entry preinstalls the listed pack before competition.ready and leaves it alone afterwards",
  { skip: process.platform !== "win32", timeout: 240_000 },
  async (t) => {
    const { root, entry } = await fixture(t);
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(environment))
      if (/^(?:HARNESSHUB_|AGENT_ENGINE$)/i.test(name))
        delete environment[name];

    const packages = async (url: string) => {
      const response = await fetch(`${url}/v1/tool-packs`);
      assert.equal(response.status, 200);
      return (
        (await response.json()) as {
          packages: {
            id: string;
            version: string;
            preinstalled?: boolean;
            engines?: string[];
          }[];
        }
      ).packages;
    };

    const first = await start(entry, environment);
    t.after(() => first.stop());
    const listed = await packages(first.url);
    assert.deepEqual(
      listed.map((item) => [item.id, item.preinstalled, item.engines]),
      [[PACK, true, ["fixture"]]],
    );
    assert.match(
      first.stderr(),
      /Preinstalled Tool Pack office-fixture auto-[a-f0-9]{12}: applied to 1 engine\(s\), 0 skipped/,
    );
    await first.stop();
    const marker = JSON.parse(
      await readFile(
        path.join(root, "state", "preinstalled-tool-packs.json"),
        "utf8",
      ),
    ) as {
      packs: Record<string, { package: { id: string; version: string } }>;
    };
    assert.equal(marker.packs[PACK]?.package.version, listed[0]!.version);
    const settings = await readFile(
      path.join(root, "state", "settings.json"),
      "utf8",
    );

    const second = await start(entry, environment);
    t.after(() => second.stop());
    assert.deepEqual(
      (await packages(second.url)).map((item) => [item.id, item.preinstalled]),
      [[PACK, true]],
    );
    assert.doesNotMatch(second.stderr(), /Preinstalled Tool Pack/);
    await second.stop();
    assert.equal(
      await readFile(path.join(root, "state", "settings.json"), "utf8"),
      settings,
    );

    // A mistyped switch stops the entry before it touches state/.
    const invalid = spawn(
      process.execPath,
      [entry, "--engine", "fixture", "--no-console"],
      {
        env: { ...environment, HARNESSHUB_PREINSTALL_TOOL_PACKS: "off" },
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let message = "";
    invalid.stderr.setEncoding("utf8");
    invalid.stderr.on("data", (chunk: string) => {
      message += chunk;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      invalid.once("error", reject);
      invalid.once("close", resolve);
    });
    assert.equal(code, 1);
    assert.match(message, /HARNESSHUB_PREINSTALL_TOOL_PACKS must be 0 or 1/);
  },
);
