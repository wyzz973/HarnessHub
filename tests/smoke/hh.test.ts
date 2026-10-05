// SPDX-License-Identifier: MIT
import { BUILD_INFO, HH_ENTRY } from "../support/entries.js";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { temporaryDirectory } from "../support/temporary.js";

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the installed `hh` launcher in plain Node and collect its outcome. */
function hh(cwd: string, args: string[]): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [fileURLToPath(HH_ENTRY), ...args],
      { cwd, timeout: 30_000 },
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
  "hh dispatches serve, version, benchmark and tools to the daemon and rollout and status to the CLI",
  { timeout: 60_000 },
  async (t) => {
    const { directory } = await temporaryDirectory(t, "harnesshub-hh-");
    const build: unknown = JSON.parse(await readFile(BUILD_INFO, "utf8"));

    const version = await hh(directory, ["serve", "--version", "--json"]);
    assert.equal(version.code, 0, version.stderr);
    assert.deepEqual(JSON.parse(version.stdout), build);
    // hh version is the same identity, also as hh --version.
    const identity = await hh(directory, ["version", "--json"]);
    assert.equal(identity.code, 0, identity.stderr);
    assert.deepEqual(JSON.parse(identity.stdout), build);
    const short = await hh(directory, ["--version"]);
    assert.equal(short.code, 0, short.stderr);
    assert.match(short.stdout, /^HarnessHub \S+ \S+/);

    const benchmark = await hh(directory, ["benchmark", "--help"]);
    assert.equal(benchmark.code, 0, benchmark.stderr);
    assert.match(benchmark.stdout, /^Usage:\n {2}hh benchmark --dataset /);

    const tools = await hh(directory, ["tools", "list"]);
    assert.equal(tools.code, 1);
    assert.equal(
      (JSON.parse(tools.stderr) as { error: { code: string } }).error.code,
      "INVALID_TOOL_PACKAGE_ARGUMENT",
    );
    const toolsHelp = await hh(directory, ["tools", "--help"]);
    assert.equal(toolsHelp.code, 0, toolsHelp.stderr);
    assert.match(
      toolsHelp.stdout,
      /^Usage: hh tools --root <absolute store directory>/,
    );

    // Model-plane commands go to the CLI, which needs the daemon's admin token.
    const status = await hh(directory, [
      "status",
      "--url",
      "http://127.0.0.1:9",
    ]);
    assert.equal(status.code, 3);
    assert.match(status.stderr, /admin\.token/);

    const rollout = await hh(directory, ["rollout"]);
    assert.equal(rollout.code, 1);
    assert.match(rollout.stderr, /^Missing --url, --run or --output\. /);

    const unknown = await hh(directory, ["deploy"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /^Unknown command: deploy\nUsage: hh /);

    const missing = await hh(directory, []);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /^Usage: hh <command>/);
    assert.equal(missing.stdout, "");

    const help = await hh(directory, ["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^Usage: hh <command>/);
    // A command's line names its subcommands, gateway's features too.
    assert.match(
      help.stdout,
      /\n {2}gateway +.*\(features, redaction, vision, search, alert, share on\|off\|status\)\n/,
    );
  },
);

void test(
  "a command's --help and its usage errors show that command's usage, not every command's",
  { timeout: 60_000 },
  async (t) => {
    const { directory } = await temporaryDirectory(t, "harnesshub-help-");
    const offline = ["--url", "http://127.0.0.1:9"];
    const cases: {
      args: string[];
      code: number;
      start: string;
      shows: string[];
      hides: string[];
    }[] = [
      {
        args: ["provider", "add", "--help"],
        code: 0,
        start: "Usage:\n  hh provider list",
        shows: ["--preset P", "Common options:"],
        hides: ["hh key", "hh group", "hh gateway"],
      },
      // A command shows its subcommands; a subcommand shows only itself.
      {
        args: ["group", "--help"],
        code: 0,
        start: "Usage:\n  hh group list",
        shows: ["\n  hh group rule list"],
        hides: ["hh provider"],
      },
      {
        args: ["group", "rule", "add", "--help"],
        code: 0,
        start: "Usage:\n  hh group rule list",
        shows: ["Common options:"],
        hides: ["hh group list"],
      },
      {
        args: ["wire", "--help"],
        code: 0,
        start: "Usage:\n  hh wire <agent> [model]",
        shows: ["\n  hh wire <agent> --rotate"],
        hides: ["hh profile", "hh agents", "hh unwire"],
      },
      {
        args: ["agents", "--help"],
        code: 0,
        start: "Usage:\n  hh agents ",
        shows: ["\n  hh agents models <agent>"],
        hides: ["hh wire <agent> [model]"],
      },
      {
        args: ["library", "add", "--help"],
        code: 0,
        start: "Usage:\n  hh library add instructions",
        shows: ["\n  hh library add mcp"],
        hides: ["hh library sync", "hh library list"],
      },
      {
        args: ["restore", "--help"],
        code: 0,
        start: "Usage:\n  hh restore",
        shows: ["passphrase"],
        hides: ["hh backup", "hh sync"],
      },
      {
        args: ["provider", "add", "x", "--base", "http://a", ...offline],
        code: 2,
        start: "Error: --base needs --preset\n\nUsage:\n  hh provider list",
        shows: [],
        hides: ["hh key"],
      },
      {
        args: ["wire", ...offline],
        code: 2,
        start: "Error: Expected <agent> [model]\n\nUsage:\n  hh wire",
        shows: [],
        hides: ["hh profile"],
      },
    ];
    const outcomes = await Promise.all(
      cases.map((item) => hh(directory, item.args)),
    );
    cases.forEach((item, index) => {
      const outcome = outcomes[index]!;
      const name = `hh ${item.args.join(" ")}`;
      const text = item.code === 0 ? outcome.stdout : outcome.stderr;
      assert.equal(outcome.code, item.code, `${name}: ${outcome.stderr}`);
      assert.ok(text.startsWith(item.start), `${name}:\n${text}`);
      for (const shown of item.shows)
        assert.ok(text.includes(shown), `${name} shows ${shown}`);
      for (const hidden of item.hides)
        assert.ok(!text.includes(hidden), `${name} hides ${hidden}`);
    });
  },
);

void test(
  "serve, rollout, tools and benchmark answer --help anywhere under hh names, and a wrong command line with the usage",
  { timeout: 60_000 },
  async (t) => {
    const { directory } = await temporaryDirectory(t, "harnesshub-entries-");
    const store = path.join(directory, "tool-packages");
    const helps: Array<[string[], string]> = [
      [["serve", "--help"], "Usage:\n  hh serve ["],
      [["serve", "x", "-h"], "Usage:\n  hh serve ["],
      [["rollout", "--help"], "Usage: hh rollout --url "],
      [["rollout", "--bogus", "--help"], "Usage: hh rollout --url "],
      [["tools", "--help"], "Usage: hh tools --root "],
      [["tools", "--root", store, "list", "--help"], "Usage: hh tools --root "],
      [["benchmark", "--help"], "Usage:\n  hh benchmark --dataset "],
      [["benchmark", "run", "--help"], "Usage:\n  hh benchmark --dataset "],
    ];
    const errors: Array<[string[], string, string]> = [
      [["serve", "--bogus"], "Error: Unknown option '--bogus'", "  hh serve ["],
      [
        ["benchmark", "run"],
        "Error: Unexpected argument 'run'",
        "  hh benchmark --dataset ",
      ],
      [
        ["benchmark"],
        "Error: --dataset and --engines are required",
        "  hh benchmark --dataset ",
      ],
    ];
    const [helped, failed] = await Promise.all([
      Promise.all(helps.map(([args]) => hh(directory, args))),
      Promise.all(errors.map(([args]) => hh(directory, args))),
    ]);
    helps.forEach(([args, start], index) => {
      const outcome = helped[index]!;
      const name = `hh ${args.join(" ")}`;
      assert.equal(outcome.code, 0, `${name}: ${outcome.stderr}`);
      assert.ok(
        outcome.stdout.startsWith(start),
        `${name}:\n${outcome.stdout}`,
      );
      assert.doesNotMatch(outcome.stdout, /\bnode |dist\//, name);
    });
    errors.forEach(([args, start, usage], index) => {
      const outcome = failed[index]!;
      const name = `hh ${args.join(" ")}`;
      assert.equal(outcome.code, 2, `${name}: ${outcome.stderr}`);
      assert.ok(
        outcome.stderr.startsWith(start),
        `${name}:\n${outcome.stderr}`,
      );
      assert.ok(
        outcome.stderr.includes(`\n\nUsage:\n${usage}`),
        `${name}:\n${outcome.stderr}`,
      );
      assert.doesNotMatch(outcome.stderr, /Benchmark did not complete/, name);
    });
  },
);

void test(
  "hh serve listens on 127.0.0.1 by default, where clients, links and wiring point",
  { timeout: 60_000 },
  async (t) => {
    const { directory } = await temporaryDirectory(t, "harnesshub-serve-");
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(HH_ENTRY),
        "serve",
        "--port",
        "0",
        "--data-dir",
        `${directory}/data`,
        "--config-dir",
        `${directory}/config`,
        "--secrets-backend",
        "file",
      ],
      {
        cwd: directory,
        env: { ...process.env, HH_OFFLINE: "1" },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const exited = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
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
    assert.ok(url, "hh serve reported ready");
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const live = await fetch(`${url}/health/live`);
    assert.equal(live.status, 200);
    child.kill("SIGTERM");
    await exited;
  },
);
