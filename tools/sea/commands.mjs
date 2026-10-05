#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Run `hh` commands through the single executable against a daemon it starts,
 * the way a person would after installing it (`pnpm test:sea`).
 *
 * Usage: node tools/sea/commands.mjs [--binary dist/sea/harnesshub] [--node]
 *   [--runs 1] [--out dist/sea/commands.json]
 *
 * Everything lives in one temporary directory: HOME, the temporary directory,
 * the extraction root, the data directory and the wiring home (`serve
 * --wiring-home`), with the file secret backend; the only upstream is the
 * strict fake provider on loopback with a synthetic key. The executable is
 * run through a symbolic link named `hh` (the binary itself on Windows), and
 * an `opencode` stub on PATH makes OpenCode an installed agent. Steps:
 * `version --json` (the build identity, `installMethod: sea`), each engine
 * launcher role started by its path under the extraction root running its
 * bundled code instead of the placeholder there, `config show` and `config get
 * server.port` (no daemon needed), `serve` until
 * its `ready` line, `status`, `provider presets`, `provider add` with the key
 * on stdin, `key create` and a gateway call with that key, `agents`, `wire
 * opencode --yes` and a gateway call with the key written into OpenCode's
 * configuration, `usage`, `unwire opencode --yes` and the same call refused,
 * `tui` without a terminal (exit 2), `console` (a sign-in link), the console
 * page at `/`, the fake provider's record of those two calls, `provider test`
 * and `provider doctor` against it (they send their own requests, so they come
 * after that record), a call to a second provider at
 * `https://api.upstream.test/v1`, which only a local CONNECT proxy
 * (tools/fake-proxy) reaches, through a TLS front of the same fake provider:
 * `serve` runs with `--proxy` and trusts the front's certificate through
 * NODE_EXTRA_CA_CERTS, as a user behind a TLS-inspecting proxy would (the
 * loopback provider above stays direct), a gateway call after which the
 * model-plane store's checkpoint worker writes the database file within 3 s
 * with a WAL under 4 MiB and no checkpoint failure or fallback in the
 * gateway log, and SIGTERM stopping `serve` with exit code 0 within 15 s
 * (not on Windows, where kill() terminates).
 *
 * `--node` runs the same steps with `node apps/hh/bin/hh.mjs` instead, for
 * comparison. `--runs N` repeats the whole sequence, each time in a new
 * directory. Prints a table of each step's exit code and median time, writes
 * every run as JSON to `--out`, and exits 1 when any step of any run fails.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startFakeProvider } from "../fake-provider/index.mjs";
import {
  startConnectProxy,
  startTlsFront,
  testCertificate,
} from "../fake-proxy/index.mjs";
import { SCRIPT_ASSETS } from "./build.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
// Synthetic: it only ever reaches the fake provider.
const UPSTREAM_KEY = "sk-synthetic-sea-commands-0001";
const MODEL = "fake/sim";
const WIRED_KEY = /hhk_a_[a-z2-7]{12}_[A-Za-z0-9_-]+/;

/** Run one command to completion; `stdin` is written and closed. */
function run(command, args, { env, cwd, stdin = "" }) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command[0], [...command.slice(1), ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? (signal ? `signal ${signal}` : -1),
        stdout,
        stderr,
        ms: performance.now() - started,
      });
    });
    child.stdin.end(stdin);
  });
}

/** Every file under `root` with its text. */
async function texts(root) {
  const files = [];
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  }))
    if (entry.isFile())
      files.push(await readFile(path.join(entry.parentPath, entry.name), "utf8"));
  return files.join("\n");
}

async function chat(url, key, model = MODEL) {
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  await response.arrayBuffer();
  return response.status;
}

export async function runCommands({ binary, node = false }) {
  const directory = await mkdtemp(path.join(tmpdir(), "hh-sea-commands-"));
  const home = path.join(directory, "home");
  const bin = path.join(directory, "bin");
  const dataDir = path.join(directory, "data");
  const wiringHome = path.join(directory, "wiring");
  const temporary = path.join(directory, "tmp");
  for (const item of [home, bin, wiringHome, temporary])
    await mkdir(item, { recursive: true });
  const windows = process.platform === "win32";
  let hh;
  if (node) hh = [process.execPath, path.join(ROOT, "apps", "hh", "bin", "hh.mjs")];
  else if (windows) hh = [binary];
  else {
    await symlink(binary, path.join(bin, "hh"));
    hh = [path.join(bin, "hh")];
  }
  const stub = path.join(bin, windows ? "opencode.cmd" : "opencode");
  await writeFile(stub, windows ? "@exit /b 1\r\n" : "#!/bin/sh\nexit 1\n");
  await chmod(stub, 0o755);
  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    HARNESSHUB_SEA_ROOT: path.join(directory, "sea-root"),
    HH_OFFLINE: "1",
  };
  const provider = await startFakeProvider({
    models: ["sim"],
    keys: { sea: UPSTREAM_KEY },
    chunkDelayMs: 0,
  });
  // An HTTPS upstream that only the proxy reaches: *.upstream.test does not
  // resolve, and the daemon trusts the front's certificate only through
  // NODE_EXTRA_CA_CERTS.
  const tls = testCertificate(["*.upstream.test"]);
  const certificate = path.join(directory, "upstream-ca.pem");
  await writeFile(certificate, tls.cert);
  const front = await startTlsFront(Number(new URL(provider.url).port), tls);
  const proxy = await startConnectProxy({
    route: (host, port) =>
      host.endsWith(".upstream.test") && port === 443 ? front.port : undefined,
  });
  const steps = [];
  let serve;
  let url;
  const step = async (name, work) => {
    try {
      const result = await work();
      steps.push({ step: name, ...result });
    } catch (error) {
      steps.push({
        step: name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
  /** An `hh` command with the daemon options; `check` judges its outcome. */
  const command = (name, args, check, stdin) =>
    step(name, async () => {
      const result = await run(
        hh,
        [...args, ...(url ? ["--data-dir", dataDir, "--url", url] : [])],
        { env, cwd: directory, stdin },
      );
      const problem = check(result);
      return {
        code: result.code,
        ms: Math.round(result.ms),
        ok: !problem,
        ...(problem
          ? { detail: `${problem}; stderr: ${result.stderr.trim().slice(0, 300)}` }
          : {}),
      };
    });
  const exit = (expected) => (result) =>
    result.code === expected ? undefined : `exit ${result.code}, expected ${expected}`;
  try {
    await command("hh version --json", ["version", "--json"], (result) => {
      if (result.code !== 0) return `exit ${result.code}`;
      const identity = JSON.parse(result.stdout);
      if (!node && identity.installMethod !== "sea")
        return `installMethod ${identity.installMethod}`;
      return undefined;
    });
    if (!node)
      await step("launcher roles (no arguments)", async () => {
        const launchers = Object.keys(SCRIPT_ASSETS).filter(
          (relative) => SCRIPT_ASSETS[relative] === "role",
        );
        const placeholders = [];
        for (const relative of launchers) {
          const result = await run(
            hh,
            [path.join(env.HARNESSHUB_SEA_ROOT, ...relative.split("/"))],
            { env, cwd: directory },
          );
          // Each prints its own usage or failure; the placeholder would throw.
          if (/role placeholder/.test(result.stderr))
            placeholders.push(path.basename(relative));
        }
        return {
          code: launchers.length,
          ok: placeholders.length === 0,
          ...(placeholders.length
            ? { detail: `ran the placeholder: ${placeholders.join(", ")}` }
            : {}),
        };
      });
    await command("hh config show", ["config", "show"], (result) =>
      result.code !== 0
        ? `exit ${result.code}`
        : /server\.port/.test(result.stdout)
          ? undefined
          : "server.port is not shown",
    );
    await command("hh config get server.port", ["config", "get", "server.port"], (result) =>
      result.code !== 0
        ? `exit ${result.code}`
        : /3180/.test(result.stdout)
          ? undefined
          : "not the default port 3180",
    );
    await step("hh serve (to ready)", async () => {
      const started = performance.now();
      serve = spawn(
        hh[0],
        [
          ...hh.slice(1),
          "serve",
          "--port",
          "0",
          "--host",
          "127.0.0.1",
          "--data-dir",
          dataDir,
          "--secrets-backend",
          "file",
          "--wiring-home",
          wiringHome,
          "--proxy",
          proxy.url,
        ],
        {
          cwd: directory,
          env: { ...env, NODE_EXTRA_CA_CERTS: certificate },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      serve.stderr.resume();
      for await (const line of createInterface({ input: serve.stdout })) {
        const event = (() => {
          try {
            return JSON.parse(line);
          } catch {
            return undefined;
          }
        })();
        if (event?.event === "ready") {
          url = event.url;
          break;
        }
      }
      if (!url) return { code: serve.exitCode, ok: false, detail: "no ready line" };
      return { code: "running", ms: Math.round(performance.now() - started), ok: true };
    });
    if (!url) throw new Error("hh serve did not start");
    await command("hh status", ["status"], exit(0));
    await command("hh provider presets", ["provider", "presets"], (result) =>
      result.code !== 0
        ? `exit ${result.code}`
        : /deepseek/.test(result.stdout)
          ? undefined
          : "no deepseek preset listed",
    );
    await command(
      "hh provider add (key on stdin)",
      [
        "provider",
        "add",
        "fake",
        "--chat",
        `${provider.url}/v1`,
        "--model",
        "sim",
        "--credential-from-stdin",
      ],
      exit(0),
      `${UPSTREAM_KEY}\n`,
    );
    let clientKey;
    await command(
      "hh key create",
      [
        "key",
        "create",
        "--name",
        "sea",
        "--allow",
        "fake/*",
        "--allow",
        "far/*",
        "--no-expiry",
      ],
      (result) => {
        clientKey = result.stdout.trim();
        return result.code !== 0
          ? `exit ${result.code}`
          : /^hhk_c_/.test(clientKey)
            ? undefined
            : "no key printed";
      },
    );
    await step("gateway call (created key)", async () => {
      const status = await chat(url, clientKey);
      return { code: status, ok: status === 200 };
    });
    await command("hh agents", ["agents"], (result) =>
      result.code !== 0
        ? `exit ${result.code}`
        : /opencode\s+OpenCode\s+installed/.test(result.stdout)
          ? undefined
          : "opencode is not listed as installed",
    );
    await command(
      "hh wire opencode --yes",
      ["wire", "opencode", MODEL, "--yes"],
      exit(0),
    );
    const wiredKey = WIRED_KEY.exec(await texts(wiringHome))?.[0];
    await step("gateway call (wired key)", async () => {
      if (!wiredKey) return { ok: false, detail: "no key in OpenCode's files" };
      const status = await chat(url, wiredKey);
      return { code: status, ok: status === 200 };
    });
    await command("hh usage", ["usage"], (result) =>
      result.code !== 0
        ? `exit ${result.code}`
        : /fake\/sim/.test(result.stdout)
          ? undefined
          : "no call to fake/sim in the usage",
    );
    await command(
      "hh unwire opencode --yes",
      ["unwire", "opencode", "--yes"],
      exit(0),
    );
    await step("gateway call (wired key after unwire)", async () => {
      if (!wiredKey) return { ok: false, detail: "no key in OpenCode's files" };
      const status = await chat(url, wiredKey);
      return { code: status, ok: status === 401 };
    });
    await command("hh tui (no terminal)", ["tui"], (result) =>
      result.code !== 2
        ? `exit ${result.code}, expected 2`
        : /hh agents/.test(result.stderr)
          ? undefined
          : "no hh agents hint",
    );
    await command("hh console", ["console"], (result) =>
      result.code !== 0
        ? `exit ${result.code}`
        : result.stdout.includes(`${url}/#login=`)
          ? undefined
          : "no sign-in link",
    );
    await step("console page /", async () => {
      const started = performance.now();
      const response = await fetch(`${url}/`, {
        headers: { accept: "text/html" },
      });
      const body = await response.text();
      return {
        code: response.status,
        ms: Math.round(performance.now() - started),
        ok:
          response.status === 200 &&
          /^text\/html/.test(response.headers.get("content-type") ?? "") &&
          /<div id="root">|<script/.test(body),
      };
    });
    const violations = provider.violations();
    await step("fake provider: two calls, no violations", async () => {
      const calls = provider.records().filter((record) => record.auth === "ok");
      return {
        code: calls.length,
        ok: calls.length === 2 && violations.length === 0,
        ...(violations.length ? { detail: JSON.stringify(violations) } : {}),
      };
    });
    await command("hh provider test fake", ["provider", "test", "fake"], (result) =>
      result.code !== 0
        ? `exit ${result.code}`
        : /^Test: fake, model sim/m.test(result.stdout)
          ? undefined
          : "no test report",
    );
    await command("hh provider doctor fake", ["provider", "doctor", "fake"], (result) =>
      result.code !== 0
        ? `exit ${result.code}`
        : /\d+ pass, \d+ warn, \d+ fail, \d+ skip/.test(result.stdout)
          ? undefined
          : "no doctor summary",
    );
    await command(
      "hh provider add far (https, behind the proxy)",
      [
        "provider",
        "add",
        "far",
        "--chat",
        "https://api.upstream.test/v1",
        "--model",
        "sim",
        "--credential-from-stdin",
      ],
      exit(0),
      `${UPSTREAM_KEY}\n`,
    );
    await step("gateway call through --proxy (https upstream)", async () => {
      const before = provider.records().length;
      const status = await chat(url, clientKey, "far/sim");
      const tunnelled = proxy.tunnels.includes("api.upstream.test:443");
      const arrived = provider.records().length > before;
      return {
        code: status,
        ok: status === 200 && tunnelled && arrived,
        ...(status === 200 && tunnelled && arrived
          ? {}
          : {
              detail: `tunnels ${JSON.stringify(proxy.tunnels)}, upstream ${arrived ? "reached" : "not reached"}`,
            }),
      };
    });
    await step("WAL checkpointed off the commits", async () => {
      // In WAL mode only a checkpoint writes the database file. The
      // model-plane connection does not checkpoint its commits (a worker
      // thread does), and nothing here brings the WAL to SQLite's automatic
      // 1000 pages: the file changing after a call is the worker's work.
      const database = path.join(dataDir, "harnesshub.sqlite");
      const before = (await stat(database)).mtimeMs;
      const status = await chat(url, clientKey, MODEL);
      let checkpointed = false;
      for (let waited = 0; waited < 3000 && !checkpointed; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        checkpointed = (await stat(database)).mtimeMs > before;
      }
      const wal = (await stat(`${database}-wal`)).size;
      const log = await readFile(
        path.join(dataDir, "logs", "gateway.log"),
        "utf8",
      );
      const failed = /store\.checkpoint_(?:failed|fallback)/.test(log);
      const ok =
        status === 200 && checkpointed && wal < 4 * 1024 * 1024 && !failed;
      return {
        code: status,
        ok,
        ...(ok
          ? {}
          : {
              detail: `database ${checkpointed ? "checkpointed" : "not checkpointed"}, WAL ${wal} bytes${failed ? ", checkpoint failure logged" : ""}`,
            }),
      };
    });
    if (!windows)
      await step("hh serve stops on SIGTERM", async () => {
        const exited = once(serve, "exit");
        serve.kill("SIGTERM");
        // Shutdown waits for the checkpoint worker (whenClosed); not forever.
        const timer = setTimeout(() => serve.kill("SIGKILL"), 15_000);
        const [code, signal] = await exited;
        clearTimeout(timer);
        return {
          code,
          ok: code === 0,
          ...(signal ? { detail: `still running after 15 s: ${signal}` } : {}),
        };
      });
  } finally {
    if (serve && serve.exitCode === null && serve.signalCode === null) {
      const exited = once(serve, "exit");
      serve.kill("SIGKILL");
      await exited;
    }
    await proxy.close();
    await front.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
  return { ok: steps.every((item) => item.ok), steps };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      binary: { type: "string" },
      node: { type: "boolean" },
      runs: { type: "string", default: "1" },
      out: { type: "string" },
    },
  });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1)
    throw new Error("--runs takes a positive integer");
  const binary = path.resolve(
    values.binary ??
      path.join(
        ROOT,
        "dist",
        "sea",
        process.platform === "win32" ? "harnesshub.exe" : "harnesshub",
      ),
  );
  const results = [];
  for (let index = 0; index < runs; index += 1)
    results.push(await runCommands({ binary, node: values.node === true }));
  const median = (numbers) => {
    const sorted = numbers.filter((value) => typeof value === "number").sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : undefined;
  };
  const steps = results.at(-1).steps.map((item, index) => ({
    ...item,
    ms: median(results.map((result) => result.steps[index]?.ms)),
    ok: results.every((result) => result.steps[index]?.ok === true),
  }));
  const record = {
    platform: process.platform,
    arch: process.arch,
    runner: values.node ? "node apps/hh/bin/hh.mjs" : path.relative(ROOT, binary),
    at: new Date().toISOString(),
    ok: results.every((result) => result.ok),
    runs: results.map((result) => result.steps),
  };
  const out = path.resolve(
    values.out ?? path.join(ROOT, "dist", "sea", values.node ? "commands-node.json" : "commands.json"),
  );
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`| Step | Exit | ms (median of ${runs}) | Result |\n|---|---|---|---|`);
  for (const item of steps)
    console.log(
      `| ${item.step} | ${item.code ?? "-"} | ${item.ms ?? "-"} | ${item.ok ? "ok" : `FAIL${item.detail ? `: ${item.detail}` : ""}`} |`,
    );
  if (!record.ok) process.exitCode = 1;
}
