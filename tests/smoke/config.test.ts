// SPDX-License-Identifier: MIT
import { HH_ENTRY } from "../support/entries.js";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { temporaryDirectory } from "../support/temporary.js";

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the installed `hh` launcher in plain Node and collect its outcome. */
function hh(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [fileURLToPath(HH_ENTRY), ...args],
      { cwd, timeout: 30_000, env },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({
          code: error === null ? 0 : Number(error.code),
          stdout,
          stderr,
        });
      },
    );
  });
}

void test(
  "hh serve starts from config.jsonc, a flag still wins, and an invalid file stops it with the key path",
  { timeout: 60_000 },
  async (t) => {
    const { directory } = await temporaryDirectory(t, "harnesshub-config-");
    const config = path.join(directory, "config");
    const data = path.join(directory, "configured-data");
    await mkdir(config, { recursive: true });
    await writeFile(
      path.join(config, "config.jsonc"),
      `// test configuration
{
  "server": { "port": 0, "host": "127.0.0.1" },
  "dataDir": ${JSON.stringify(data)},
  "secrets": { "backend": "file" },
  "catalog": { "autoRefresh": false }
}
`,
    );
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(HH_ENTRY),
        "serve",
        "--config-dir",
        config,
        "--secrets-backend",
        "file",
      ],
      {
        cwd: directory,
        env: { ...process.env, HH_OFFLINE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    let url: string | undefined;
    for await (const line of createInterface({ input: child.stdout })) {
      const event = (() => {
        try {
          return JSON.parse(line) as { event?: string; url?: string };
        } catch {
          return undefined;
        }
      })();
      if (event?.event === "ready") {
        url = event.url;
        break;
      }
    }
    assert.ok(url, `hh serve reported ready: ${stderr}`);
    assert.equal((await fetch(`${url}/health/live`)).status, 200);
    // The data root came from the file.
    await access(path.join(data, "admin.token"));
    assert.match(
      stderr,
      /Config: .*config\.jsonc \(.*server\.port from file.*secrets\.backend from flag --secrets-backend.*catalog\.autoRefresh from env HH_OFFLINE/,
    );
    child.kill("SIGTERM");
    await exited;

    await writeFile(
      path.join(config, "config.jsonc"),
      '{"server": {"port": 0, "portt": 1}}\n',
    );
    const refused = await hh(directory, ["serve", "--config-dir", config]);
    assert.equal(refused.code, 2, refused.stderr);
    assert.match(refused.stderr, /CONFIG_UNKNOWN_KEY: .*server\.portt/);
  },
);

void test("hh config shows, gets, sets and unsets settings with their sources", async (t) => {
  const { directory } = await temporaryDirectory(t, "harnesshub-config-cli-");
  const config = path.join(directory, "config");
  const env = { ...process.env, AGENT_ENGINE: "codex" };
  const run = (...args: string[]) =>
    hh(directory, ["config", ...args, "--config-dir", config], env);

  const set = await run("set", "wiring.autoSync", "false");
  assert.equal(set.code, 0, set.stderr);
  const shown = await run("show", "--json");
  assert.equal(shown.code, 0, shown.stderr);
  const settings = (
    JSON.parse(shown.stdout) as {
      settings: Array<{ path: string; value: unknown; source: unknown }>;
    }
  ).settings;
  const find = (key: string) => settings.find((item) => item.path === key);
  assert.deepEqual(find("wiring.autoSync"), {
    ...find("wiring.autoSync"),
    value: false,
    source: { kind: "file" },
  });
  assert.deepEqual(find("engines.default")?.source, {
    kind: "env",
    name: "AGENT_ENGINE",
  });
  assert.deepEqual(find("server.port")?.source, { kind: "default" });
  assert.deepEqual(
    (
      JSON.parse(shown.stdout) as { runtime: Array<{ command: string }> }
    ).runtime.map((setting) => setting.command),
    ["hh gateway share", "hh gateway features"],
  );
  const table = await run("show");
  assert.match(table.stdout, /^wiring\.autoSync\s+false\s+file$/m);
  assert.match(
    table.stdout,
    /LAN sharing: .*gateway-sharing\.json \(hh gateway share\)/,
  );
  assert.equal((await run("get", "wiring.autoSync")).stdout, "false\n");
  assert.equal(
    (await run("get", "server")).stdout,
    '{"host":"127.0.0.1","port":3180}\n',
  );

  const secret = await run(
    "set",
    "otlp.headers.authorization",
    "Bearer abcdefghijklmnop",
  );
  assert.equal(secret.code, 2);
  assert.match(secret.stderr, /CONFIG_SECRET/);
  const unknown = await run("get", "nothing.here");
  assert.equal(unknown.code, 2);
  assert.equal((await run("unset", "wiring.autoSync")).code, 0);
  assert.equal(
    await readFile(path.join(config, "config.jsonc"), "utf8"),
    "// HarnessHub configuration: hh config show lists the settings.\n{}\n",
  );
});
