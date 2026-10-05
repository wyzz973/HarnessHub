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

/**
 * The subcommands a command's `--help` names: the first word of each of its
 * usage entries (`hh <command> <word>`), and the alternatives after ` | `
 * of an entry whose first word is not followed by another word (`hh gateway
 * share status | off` names only `share`).
 */
function helpSubcommands(command: string, help: string): Set<string> {
  const found = new Set<string>();
  const entries = help.split(new RegExp(`^ +hh ${command} `, "m")).slice(1);
  for (const entry of entries) {
    const first = /^([a-z][a-z-]*)( +[a-z][a-z-]*(?=\s))?/.exec(entry);
    if (!first) continue;
    found.add(first[1]!);
    if (first[2] !== undefined) continue;
    for (const match of entry.matchAll(/(?:^|\s)\| +([a-z][a-z-]*)(?=\s|$)/gm))
      found.add(match[1]!);
  }
  return found;
}

void test(
  "hh --help names each command's subcommands as its --help does, and every hh usage --by",
  { timeout: 60_000 },
  async (t) => {
    const { directory } = await temporaryDirectory(t, "harnesshub-hh-help-");
    const top = await hh(directory, ["--help"]);
    assert.equal(top.code, 0, top.stderr);
    const summaries = new Map(
      [...top.stdout.matchAll(/^ {2}([a-z]+) +(.+)$/gm)].map((match) => [
        match[1]!,
        match[2]!,
      ]),
    );
    let checked = 0;
    for (const [command, summary] of summaries) {
      // A list of subcommands in parentheses, not a pointer to more help.
      const listed = /\(([^)]*)\)$/.exec(summary)?.[1];
      if (
        listed === undefined ||
        !/^[a-z][a-z |-]*(?:, [a-z][a-z |-]*)*$/.test(listed) ||
        listed.startsWith("hh ")
      )
        continue;
      const help = await hh(directory, [command, "--help"]);
      assert.equal(help.code, 0, `${command}: ${help.stderr}`);
      assert.deepEqual(
        new Set(listed.split(", ").map((item) => item.split(/[ |]/)[0]!)),
        helpSubcommands(command, help.stdout),
        `hh --help's summary of ${command}`,
      );
      checked++;
    }
    assert.ok(checked >= 10, `only ${checked} summaries list subcommands`);
    const usage = await hh(directory, ["usage", "--help"]);
    const by = /--by ([a-z|]+)\]/.exec(usage.stdout)?.[1]?.split("|");
    assert.ok(by && by.length > 3, usage.stdout);
    for (const value of by)
      assert.match(summaries.get("usage")!, new RegExp(`\\b${value}\\b`));
  },
);

/**
 * Run `hh` with `closed` (stdout or stderr) a pipe whose reader has gone
 * before hh writes, as in `hh … | true`; the other stream is collected.
 */
function hhClosing(
  cwd: string,
  args: string[],
  closed: "stdout" | "stderr",
): Promise<{ code: number | null; signal: string | null; other: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(HH_ENTRY), ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child[closed].destroy();
    let other = "";
    child[closed === "stdout" ? "stderr" : "stdout"]
      .setEncoding("utf8")
      .on("data", (chunk: string) => (other += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, other });
    });
  });
}

void test(
  "a closed stdout or stderr ends no command early: its output is dropped and its exit code kept",
  { timeout: 60_000 },
  async (t) => {
    const { directory } = await temporaryDirectory(t, "harnesshub-pipes-");
    // provider --help writes to stdout, an unknown subcommand to stderr.
    const help = await hhClosing(directory, ["provider", "--help"], "stdout");
    assert.deepEqual([help.code, help.signal], [0, null], help.other);
    assert.doesNotMatch(help.other, /EPIPE|Unhandled 'error' event/);
    const wrong = await hhClosing(
      directory,
      ["provider", "bogus", "--data-dir", path.join(directory, "data")],
      "stderr",
    );
    assert.deepEqual([wrong.code, wrong.signal], [2, null]);
    // The daemon's absence is still reported, with its own exit code.
    const down = await hhClosing(
      directory,
      [
        "status",
        "--url",
        "http://127.0.0.1:9",
        "--data-dir",
        path.join(directory, "data"),
      ],
      "stdout",
    );
    assert.equal(down.code, 3, down.other);
    assert.match(down.other, /admin token/);
  },
);

void test(
  "the common options may come before the command; other options there are refused",
  { timeout: 60_000 },
  async (t) => {
    const { directory } = await temporaryDirectory(t, "harnesshub-options-");
    const data = path.join(directory, "data");
    // Read as hh status --url … --data-dir …: the token is looked up there.
    const before = await hh(directory, [
      "--url",
      "http://127.0.0.1:9",
      `--data-dir=${data}`,
      "status",
    ]);
    assert.equal(before.code, 3, before.stderr);
    assert.ok(before.stderr.includes(path.join(data, "admin.token")));
    const json = await hh(directory, ["--json", "--version"]);
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(
      JSON.parse(json.stdout),
      JSON.parse(await readFile(BUILD_INFO, "utf8")),
    );
    // A command that does not take one refuses it as written after it.
    const refused = await hh(directory, ["--url", "http://x", "version"]);
    assert.equal(refused.code, 2);
    const other = await hh(directory, ["--port", "1", "status"]);
    assert.equal(other.code, 2);
    assert.match(
      other.stderr,
      /^Unknown option before the command: --port\. Before it, hh takes only --url, --data-dir, --json, --yes, --non-interactive/,
    );
    const valueless = await hh(directory, ["--url"]);
    assert.equal(valueless.code, 2);
    assert.match(valueless.stderr, /^--url needs a value\n/);
    const alone = await hh(directory, ["--json"]);
    assert.equal(alone.code, 2);
    assert.match(alone.stderr, /^Give a command after the options\n/);
  },
);

void test(
  "hh provider presets lists the bundled presets when no daemon answers",
  { timeout: 60_000 },
  async (t) => {
    const { directory } = await temporaryDirectory(t, "harnesshub-presets-");
    const { listPresets } = await import("@harnesshub/gateway/presets");
    const listed = await hh(directory, ["provider", "presets"]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /^Vendors \(\d+\)\nPRESET /);
    assert.match(listed.stdout, /\ndeepseek +DeepSeek /);
    assert.match(
      listed.stderr,
      /^No daemon answered \(Cannot read the admin token .+\); listing the presets bundled with this hh, which its daemon serves\.\n$/,
    );
    const json = await hh(directory, ["provider", "presets", "--json"]);
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(
      (JSON.parse(json.stdout) as { items: Array<{ id: string }> }).items.map(
        (item) => item.id,
      ),
      listPresets().map((preset) => preset.id),
    );
    // Other commands still need the daemon.
    assert.equal((await hh(directory, ["provider", "list"])).code, 3);
  },
);
