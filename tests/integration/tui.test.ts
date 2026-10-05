// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { wiringAdapter } from "@harnesshub/agents/wiring/index";
import { runTui } from "@harnesshub/cli/tui";
import { startHub } from "@harnesshub/daemon/main";
import type { HarnessHubClient } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { SqliteModelPlaneStore } from "@harnesshub/store/storage/model-plane-store";
import { HH_ENTRY } from "../support/entries.js";
import { startFakeProvider } from "../support/fake-provider.js";
import { FakeInput, FakeOutput, KEYS } from "../support/terminal.js";
import { temporaryDirectory } from "../support/temporary.js";

// Synthetic values only: they never reach a real service.
const KEY = "sk-synthetic-tui-upstream-0001";
const LARGE = "fake/sim-large";
const SMALL = "fake/sim-small";
const GROUP = "group/fast";

interface Machine {
  client: HarnessHubClient;
  url: string;
  dataDir: string;
  home: string;
  directory: string;
  /** Claude Code's managed settings, when `policy` was given. */
  policy?: { file: string; shown: string };
}

/**
 * A daemon whose wiring home has `claude` and `codex` commands (never run)
 * on its PATH, and those of `commands`, and a Codex configuration
 * directory, a provider on the strict fake upstream with two priced models,
 * and a route group over them. With `policy`, an administrator's Claude
 * Code managed settings with that text, where this platform keeps them,
 * under a system root of its own.
 */
async function machine(
  t: TestContext,
  options: { policy?: string; commands?: string[] } = {},
): Promise<Machine> {
  const { directory, defer } = await temporaryDirectory(t, "hh-tui-");
  const systemRoot = path.join(directory, "system");
  let policy: Machine["policy"];
  if (options.policy !== undefined) {
    const [shown] = wiringAdapter("claude").managedFiles!(process.platform);
    const file = path.join(systemRoot, shown!.replace(/^[A-Za-z]:/, ""));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, options.policy);
    policy = { file, shown: shown! };
  }
  const home = path.join(directory, "home");
  const bin = path.join(directory, "bin");
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await mkdir(bin);
  for (const name of ["claude", "codex", ...(options.commands ?? [])]) {
    const command = path.join(
      bin,
      process.platform === "win32" ? `${name}.cmd` : name,
    );
    await writeFile(command, "exit 1\n");
    await chmod(command, 0o755);
  }
  const fake = await startFakeProvider({
    models: ["sim-large", "sim-small"],
    keys: { upstream: KEY },
    chunkDelayMs: 0,
  });
  defer(() => fake.close());
  const dataDir = path.join(directory, "data");
  const hub = await startHub({
    dataDir,
    configDir: path.join(directory, "config"),
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
    catalog: { autoRefresh: false },
    wiringHome: {
      home,
      env: { PATH: bin },
      ...(policy ? { systemRoot } : {}),
    },
  });
  defer(() => hub.server.close());
  const client = await connectLocal({ dataDir, url: hub.url });
  await client.providers.create({
    id: "fake",
    name: "Fake Cloud",
    kind: "custom",
    endpoints: { chat: `${fake.url}/v1` },
    models: {
      source: "manual",
      list: [
        {
          id: "sim-large",
          contextWindow: 1_000_000,
          price: { input: 3, output: 15 },
        },
        {
          id: "sim-small",
          contextWindow: 128_000,
          price: { input: 0.25, output: 1.25 },
        },
      ],
      expose: "all",
    },
    credential: { value: KEY },
  });
  await client.routeGroups.create({ id: "fast", members: [SMALL, LARGE] });
  return {
    client,
    url: hub.url,
    dataDir,
    home,
    directory,
    ...(policy ? { policy } : {}),
  };
}

interface Session {
  input: FakeInput;
  output: FakeOutput;
  host: EventEmitter;
  errors: { text: string };
  done: Promise<number>;
  /** Type `keys`, then wait until the screen shows what `test` accepts. */
  press(
    keys: string,
    test: (screen: string) => boolean,
    what: string,
  ): Promise<string>;
}

function session(
  client: HarnessHubClient | (() => Promise<HarnessHubClient>),
  options: {
    columns?: number;
    rows?: number;
    env?: Record<string, string>;
  } = {},
): Session {
  const input = new FakeInput();
  const output = new FakeOutput(options.columns ?? 110, options.rows ?? 26);
  const host = new EventEmitter();
  const errors = {
    text: "",
    write(text: string) {
      this.text += text;
    },
  };
  const done = runTui({
    connect: typeof client === "function" ? client : async () => client,
    input,
    output,
    errors,
    host,
    env: options.env ?? {},
  });
  return {
    input,
    output,
    host,
    errors,
    done,
    press: (keys, test, what) => {
      input.type(keys);
      return output.waitFor(test, what);
    },
  };
}

/** The screen row of the agent the cursor is on. */
function selected(screen: string): string {
  return screen.split("\n").find((line) => line.startsWith("  ▸ ")) ?? "";
}

/** Move the cursor down until it is on `name`. */
async function select(tui: Session, name: string): Promise<string> {
  for (let tries = 0; tries < 10; tries += 1) {
    const screen = tui.output.screen.text();
    if (selected(screen).includes(name)) return screen;
    const before = selected(screen);
    await tui.press(
      KEYS.down,
      (text) => selected(text) !== before,
      `the cursor moving down from ${before}`,
    );
  }
  throw new Error(`The cursor never reached ${name}`);
}

/** Every file under `root` with its text. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  }))
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      files[path.relative(root, file)] = await readFile(file, "utf8");
    }
  return files;
}

/** The terminal is as before the session: cooked mode, main screen, cursor shown, no listeners. */
function assertRestored(tui: Session): void {
  assert.equal(tui.input.raw, false);
  assert.equal(tui.input.paused, true);
  assert.equal(tui.output.screen.alternate, false);
  assert.equal(tui.output.screen.cursorVisible, true);
  assert.equal(tui.input.listenerCount("data"), 0);
  assert.equal(tui.output.listenerCount("resize"), 0);
  for (const event of ["SIGINT", "SIGTERM", "exit"])
    assert.equal(tui.host.listenerCount(event), 0, event);
}

const listed = (screen: string) =>
  screen.includes("Claude Code") && screen.includes("Codex");

void test("hh tui picks a model, shows the plan and wires the agent after y", async (t) => {
  const on = await machine(t);
  // Without color the field the cursor is on is bracketed, which the test reads.
  const tui = session(on.client, { env: { NO_COLOR: "1" } });
  let screen = await tui.output.waitFor(listed, "the agents");
  // Installed agents are listed; those not found are folded into one line.
  assert.match(screen, /▸ Claude Code +not wired/);
  assert.match(screen, /^ {4}Codex CLI +not wired/m);
  assert.match(screen, /\d+ not installed: .*OpenCode/);
  assert.doesNotMatch(screen, /^ {4}OpenCode/m);
  assert.match(screen, /↑↓ agent {2}· {2}←→ field {2}· {2}↵ change/);
  assert.equal(tui.output.screen.alternate, true);
  assert.equal(tui.input.raw, true);

  screen = await select(tui, "Codex CLI");
  assert.match(selected(screen), /not wired +\[—\] +effort — +codexAuth —/);
  // ←→ moves between the agent's fields: model, subagent, effort, codexAuth.
  await tui.press(
    KEYS.right + KEYS.right + KEYS.right,
    (text) => /codexAuth\[—\]/.test(selected(text)),
    "the codexAuth field",
  );
  await tui.press(
    KEYS.left + KEYS.left + KEYS.left,
    (text) => /not wired +\[—\]/.test(selected(text)),
    "the model field again",
  );
  screen = await tui.press(
    KEYS.enter,
    (text) => text.includes("❯") && text.includes(LARGE),
    "the model picker",
  );
  // Grouped by provider with window and price, then the route groups.
  assert.match(screen, /Codex CLI › model/);
  assert.match(
    screen,
    /Fake Cloud \(fake\)\n {2}▸ fake\/sim-large +1M ctx · \$3 \/ \$15 per M/,
  );
  assert.match(screen, /fake\/sim-small +128K ctx · \$0\.25 \/ \$1\.25 per M/);
  assert.match(
    screen,
    /Route groups\n {4}group\/fast +order · 2 models · 128K ctx/,
  );

  screen = await tui.press(
    "small",
    (text) => text.includes("❯ small") && !text.includes(LARGE),
    "the filtered models",
  );
  assert.match(screen, /▸ fake\/sim-small/);
  const before = await snapshot(on.home);
  screen = await tui.press(
    KEYS.enter,
    (text) => text.includes("Write these changes"),
    "the plan",
  );
  assert.match(screen, /Codex CLI › model › fake\/sim-small/);
  assert.match(screen, /(Change|Create) .*config\.toml/);
  assert.match(screen, /^ {2}\+.*fake\/sim-small/m);
  assert.match(screen, /y yes {2}· {2}n no/);
  // Nothing is written before the answer.
  assert.deepEqual(await snapshot(on.home), before);

  screen = await tui.press(
    "y",
    (text) => text.includes("✓ Codex CLI: model fake/sim-small"),
    "the wired agent",
  );
  assert.match(
    selected(screen),
    /Codex CLI +✓ wired +\[fake\/sim-small\] +effort — +codexAuth gateway-key/,
  );
  const agent = await on.client.agents.get("codex");
  assert.equal(agent.wiring?.model, SMALL);
  const config = await readFile(
    path.join(on.home, ".codex", "config.toml"),
    "utf8",
  );
  assert.match(config, /fake\/sim-small/);
  // The key went into the agent's files but never onto the screen.
  const files = Object.values(await snapshot(on.home)).join("\n");
  const key = /hhk_a_[a-z2-7]{12}_[A-Za-z0-9_-]+/.exec(files)?.[0];
  assert.ok(key, "the wired key is in the agent's files");
  assert.equal(tui.output.written.includes(key), false);

  await tui.press("q", () => true, "quit");
  assert.equal(await tui.done, 0);
  assertRestored(tui);
});

void test("hh tui leaves every file as it was when the plan is declined, typed ahead or the picker closed", async (t) => {
  const on = await machine(t);
  const before = await snapshot(on.home);
  const keys = (await on.client.gatewayKeys.list()).items.length;
  const tui = session(on.client);
  await tui.output.waitFor(listed, "the agents");
  await tui.press(KEYS.enter, (text) => text.includes("❯"), "the picker");
  await tui.press(
    KEYS.escape,
    (text) => text.includes("› agents"),
    "the list after esc",
  );
  await tui.press(KEYS.enter, (text) => text.includes("❯"), "the picker");
  // A y typed while the plan is being made is dropped, not taken as the answer.
  await tui.press(
    KEYS.enter,
    (text) => text.includes("… Planning Claude Code…"),
    "the plan being made",
  );
  tui.input.type("y");
  await tui.output.waitFor(
    (text) => text.includes("Write these changes"),
    "the plan",
  );
  assert.deepEqual(await snapshot(on.home), before);
  assert.equal((await on.client.agents.get("claude")).wiring, null);
  const screen = await tui.press(
    "n",
    (text) => text.includes("Cancelled; nothing was changed."),
    "the cancellation",
  );
  assert.match(selected(screen), /Claude Code +not wired/);
  assert.deepEqual(await snapshot(on.home), before);
  assert.equal((await on.client.agents.get("claude")).wiring, null);
  assert.equal((await on.client.gatewayKeys.list()).items.length, keys);

  // u on an agent that is not wired changes nothing either.
  await tui.press(
    "u",
    (text) => text.includes("✗ Claude Code is not wired."),
    "the refusal to unwire",
  );
  await tui.press("q", () => true, "quit");
  assert.equal(await tui.done, 0);
  assert.deepEqual(await snapshot(on.home), before);
});

void test("hh tui saves a profile and applies it after a preview", async (t) => {
  const on = await machine(t);
  const plan = await on.client.agents.plan("claude", {
    model: LARGE,
    tiers: { haiku: SMALL },
  });
  await on.client.agents.wire("claude", {
    model: LARGE,
    tiers: { haiku: SMALL },
    expect: plan,
  });
  const tui = session(on.client);
  await tui.output.waitFor(listed, "the agents");

  let screen = await tui.press(
    "s",
    (text) => text.includes("› save profile"),
    "the name prompt",
  );
  assert.match(screen, /Claude Code +fake\/sim-large +haiku fake\/sim-small/);
  screen = await tui.press(
    "work" + KEYS.enter,
    (text) => text.includes("✓ Saved profile work: 1 agent(s)."),
    "the saved profile",
  );
  const saved = await on.client.profiles.get("work");
  assert.deepEqual(saved.agents.claude?.model, LARGE);
  assert.deepEqual(saved.agents.claude?.tiers, { haiku: SMALL });

  // Switch the model away in the TUI.
  await tui.press(KEYS.enter, (text) => text.includes("❯"), "the picker");
  await tui.press(
    "fast",
    (text) => text.includes("❯ fast") && !text.includes(LARGE),
    "the route group",
  );
  await tui.press(
    KEYS.enter,
    (text) => text.includes("Write these changes"),
    "the plan",
  );
  screen = await tui.press(
    "y",
    (text) => text.includes("✓ Claude Code: model group/fast"),
    "the switched model",
  );
  assert.equal((await on.client.agents.get("claude")).wiring?.model, GROUP);
  // Choosing the current model again writes nothing and issues no key.
  const keys = (await on.client.gatewayKeys.list()).items.length;
  await tui.press(
    KEYS.enter,
    (text) => /▸ group\/fast .*current/.test(text),
    "the picker on the current model",
  );
  await tui.press(
    KEYS.enter,
    (text) =>
      text.includes(
        "Claude Code already has model group/fast; nothing to write.",
      ),
    "nothing to write",
  );
  assert.equal((await on.client.gatewayKeys.list()).items.length, keys);

  screen = await tui.press(
    "p",
    (text) => text.includes("› profiles"),
    "the profiles",
  );
  assert.match(screen, /▸ work +claude fake\/sim-large/);
  screen = await tui.press(
    KEYS.enter,
    (text) => text.includes("Switch claude to profile work?"),
    "the profile preview",
  );
  assert.match(screen, /profiles › work/);
  assert.match(screen, /^ {2}claude:/m);
  assert.match(screen, /^ {2}\+.*fake\/sim-large/m);
  screen = await tui.press(
    "y",
    (text) => text.includes("✓ Applied profile work: claude."),
    "the applied profile",
  );
  assert.match(selected(screen), /Claude Code +✓ wired +fake\/sim-large/);
  const wiring = (await on.client.agents.get("claude")).wiring;
  assert.equal(wiring?.model, LARGE);
  assert.deepEqual(wiring?.tiers, { haiku: SMALL });

  // Applying it again finds nothing to change.
  await tui.press("p", (text) => text.includes("› profiles"), "the profiles");
  await tui.press(
    KEYS.enter,
    (text) => text.includes("Every agent already matches profile work."),
    "the matching profile",
  );
  await tui.press("q", () => true, "quit");
  assert.equal(await tui.done, 0);
});

void test("hh tui unfolds the agents not installed and scrolls the list to the cursor", async (t) => {
  const on = await machine(t);
  const tui = session(on.client, { rows: 14 });
  await tui.output.waitFor(listed, "the agents");
  let screen = await tui.press(
    "f",
    (text) => /^ {4}OpenCode +not installed/m.test(text),
    "the unfolded agents",
  );
  assert.doesNotMatch(screen, /\d+ not installed:/);
  // Up from the first agent wraps to the last, and the list scrolls to it.
  const last = (await on.client.agents.list()).items.at(-1)!.name;
  screen = await tui.press(
    KEYS.up,
    (text) => selected(text).includes(last),
    "the last agent",
  );
  assert.doesNotMatch(screen, /Claude Code/);
  assert.equal(tui.output.screen.overflowed, false);
  // Folding again moves the cursor off the folded agent, to the first one.
  screen = await tui.press(
    "f",
    (text) => /\d+ not installed:/.test(text),
    "the folded agents",
  );
  assert.match(selected(screen), /Claude Code/);
  await tui.press("q", () => true, "quit");
  assert.equal(await tui.done, 0);
});

void test("hh tui redraws on resize and fits narrow and tiny terminals", async (t) => {
  const on = await machine(t);
  const codex = path.join(on.home, ".codex");
  const columns = Math.max(120, codex.length + 80);
  const tui = session(on.client, { columns, rows: 24 });
  await tui.output.waitFor(listed, "the agents");
  let screen = await select(tui, "Codex CLI");
  // The selected agent's configuration directory is at the right edge.
  assert.ok(selected(screen).endsWith(codex), selected(screen));
  assert.equal(selected(screen).length, columns - 2);
  assert.equal(tui.output.screen.lines()[23]?.includes("q quit"), true);

  tui.output.resize(48, 14);
  screen = await tui.output.waitFor(
    (text) => text.split("\n").length >= 13 && !selected(text).includes(codex),
    "the narrow screen",
  );
  assert.equal(tui.output.screen.overflowed, false);
  const lines = tui.output.screen.lines();
  assert.deepEqual(
    lines.filter((line) => [...line].length > 48),
    [],
  );
  // The hints wrap onto more lines and still end at the last row.
  assert.ok(lines.at(-1)?.includes("q quit"), lines.join("\n"));
  assert.ok(lines.filter((line) => line.includes("  ·  ")).length >= 3);
  assert.match(selected(screen), /^ {2}▸ Codex CLI/);

  tui.output.resize(20, 6);
  await tui.output.waitFor(
    (text) => text === "Too small: 20x6\nNeeds 30x8",
    "the size notice",
  );
  tui.output.resize(100, 20);
  screen = await tui.output.waitFor(
    (text) => listed(text) && !text.includes("Too small"),
    "the full screen again",
  );
  assert.match(selected(screen), /Codex CLI/);
  assert.equal(tui.output.screen.overflowed, false);
  await tui.press("q", () => true, "quit");
  assert.equal(await tui.done, 0);
  assertRestored(tui);
});

void test("hh tui writes no SGR sequences when NO_COLOR is set", async (t) => {
  const on = await machine(t);
  for (const [env, styled] of [
    [{}, true],
    [{ NO_COLOR: "1" }, false],
  ] as const) {
    const tui = session(on.client, { env });
    const screen = await tui.output.waitFor(listed, "the agents");
    assert.equal(tui.output.screen.styles > 0, styled);
    if (!styled) assert.match(selected(screen), /\[—\]/);
    await tui.press("q", () => true, "quit");
    assert.equal(await tui.done, 0);
    assert.equal(/\x1b\[[0-9;]*m/.test(tui.output.written), styled);
  }
});

void test("hh tui restores the terminal on q, Ctrl+C, SIGINT, SIGTERM, exit and a crash", async (t) => {
  const on = await machine(t);
  const endings: Array<[string, (tui: Session) => void, number]> = [
    ["esc and q", (tui) => tui.input.type(KEYS.escape + "q"), 0],
    ["Ctrl+C", (tui) => tui.input.type(KEYS.interrupt), 130],
    ["SIGINT", (tui) => tui.host.emit("SIGINT"), 130],
    ["SIGTERM", (tui) => tui.host.emit("SIGTERM"), 143],
    ["exit", (tui) => tui.host.emit("exit", 1), 1],
  ];
  for (const [name, end, code] of endings) {
    const tui = session(on.client);
    await tui.output.waitFor(listed, "the agents");
    // Ctrl+C quits even from a picker, where q would be typed.
    await tui.press(KEYS.enter, (text) => text.includes("❯"), "the picker");
    end(tui);
    assert.equal(await tui.done, code, name);
    assertRestored(tui);
    assert.ok(tui.output.written.endsWith("\x1b[?25h\x1b[?1049l"), name);
  }

  // An error that is not the daemon's restores the terminal and propagates.
  const broken = await connectLocal({ dataDir: on.dataDir, url: on.url });
  broken.profiles.list = () => Promise.reject(new TypeError("boom"));
  const tui = session(broken);
  await tui.output.waitFor(listed, "the agents");
  tui.input.type("p");
  await assert.rejects(tui.done, /boom/);
  assertRestored(tui);
});

void test("hh tui refuses without a terminal and without a running daemon", async (t) => {
  const on = await machine(t);
  // The real launcher with piped stdio: no terminal.
  const result = await new Promise<{ code: number; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(HH_ENTRY),
          "tui",
          "--data-dir",
          on.dataDir,
          "--url",
          on.url,
        ],
        { cwd: on.directory, stdio: ["pipe", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr
        .setEncoding("utf8")
        .on("data", (chunk: string) => (stderr += chunk));
      child.stdout.resume();
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? -1, stderr }));
      child.stdin.end("");
    },
  );
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /needs a terminal.*hh agents/);

  // A daemon that is not listening: the hint, 3, and the screen never opened.
  const closed = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        resolve(typeof address === "object" && address ? address.port : 0),
      );
    });
  });
  const tui = session(() =>
    connectLocal({ dataDir: on.dataDir, url: `http://127.0.0.1:${closed}` }),
  );
  assert.equal(await tui.done, 3);
  assert.match(tui.errors.text, /not running[\s\S]*hh serve/);
  assert.equal(tui.output.written, "");
  assert.equal(tui.input.raw, false);
});

void test("hh tui keeps Codex's own model in ChatGPT mode and asks for a model when it switches back", async (t) => {
  const on = await machine(t);
  // The daemon says with which options an agent may keep its own model.
  assert.deepEqual(
    (await on.client.agents.get("codex")).capabilities.ownModel,
    [{ codexAuth: "chatgpt" }],
  );
  assert.deepEqual(
    (await on.client.agents.get("claude")).capabilities.ownModel,
    [],
  );
  const tui = session(on.client, { env: { NO_COLOR: "1" } });
  await tui.output.waitFor(listed, "the agents");
  await select(tui, "Codex CLI");
  // model, subagent, effort, codexAuth: the option is the fourth field.
  await tui.press(
    KEYS.right + KEYS.right + KEYS.right,
    (text) => /codexAuth\[—\]/.test(selected(text)),
    "the codexAuth field",
  );
  await tui.press(KEYS.enter, (text) => text.includes("❯"), "the options");
  let screen = await tui.press(
    "chatgpt" + KEYS.enter,
    (text) => text.includes("Write these changes"),
    "the plan",
  );
  assert.match(screen, /Codex CLI › codexAuth › chatgpt/);
  assert.match(screen, /^ {2}\+openai_base_url = .*\/backend-api\/codex\//m);
  screen = await tui.press(
    "y",
    (text) => text.includes("✓ Codex CLI: codexAuth chatgpt"),
    "the wired agent",
  );
  // It keeps its own model, so it has no effort to set.
  assert.match(
    selected(screen),
    /Codex CLI +✓ wired +\(its own\) +codexAuth\[chatgpt\]/,
  );
  assert.doesNotMatch(selected(screen), /effort/);
  assert.equal((await on.client.agents.get("codex")).wiring?.model, undefined);

  // The model picker offers its own model first, as the current choice.
  await tui.press(
    KEYS.left,
    (text) => /\[\(its own\)\]/.test(selected(text)),
    "the model field",
  );
  screen = await tui.press(
    KEYS.enter,
    (text) => text.includes("❯") && text.includes(LARGE),
    "the model picker",
  );
  assert.match(
    screen,
    /▸ \(its own model\) +Codex CLI keeps the model it picks itself · current/,
  );
  await tui.press(KEYS.escape, (text) => !text.includes("❯"), "the list");

  // Back to the gateway's key: that mode needs a model, which is asked for.
  await tui.press(
    KEYS.right,
    (text) => /codexAuth\[chatgpt\]/.test(selected(text)),
    "the codexAuth field",
  );
  await tui.press(KEYS.enter, (text) => text.includes("❯"), "the options");
  screen = await tui.press(
    "gateway" + KEYS.enter,
    (text) => text.includes("codexAuth gateway-key › model"),
    "the model picker for the new mode",
  );
  assert.match(screen, /needs a model with codexAuth gateway-key: pick one/);
  assert.doesNotMatch(screen, /\(its own model\)/);
  screen = await tui.press(
    "small" + KEYS.enter,
    (text) => text.includes("Write these changes"),
    "the plan",
  );
  assert.match(screen, /codexAuth gateway-key › fake\/sim-small/);
  screen = await tui.press(
    "y",
    (text) =>
      text.includes("✓ Codex CLI: codexAuth gateway-key, model fake/sim-small"),
    "the wired agent",
  );
  assert.match(
    selected(screen),
    /Codex CLI +✓ wired +fake\/sim-small +effort — +codexAuth\[gateway-key\]/,
  );
  const wiring = (await on.client.agents.get("codex")).wiring;
  assert.equal(wiring?.model, SMALL);
  assert.deepEqual(wiring?.options, { codexAuth: "gateway-key" });
  await tui.press("q", () => true, "quit");
  assert.equal(await tui.done, 0);
});

void test("hh tui marks a wiring without a key and gives it one after y", async (t) => {
  const on = await machine(t);
  await on.client.agents.wire("codex", {
    options: { codexAuth: "chatgpt" },
    expect: await on.client.agents.plan("codex", {
      options: { codexAuth: "chatgpt" },
    }),
  });
  // As ChatGPT mode wired it before it took a key.
  const plane = new SqliteModelPlaneStore(
    path.join(on.dataDir, "harnesshub.sqlite"),
  );
  try {
    const record = (await plane.listWirings()).find(
      (item) => item.adapterId === "codex",
    )!;
    await plane.revokeGatewayKey(record.keyId!, new Date().toISOString());
    const { keyId: _old, ...legacy } = record;
    await plane.putWiring(legacy);
  } finally {
    plane.close();
    await plane.whenClosed();
  }
  const tui = session(on.client, { env: { NO_COLOR: "1" } });
  await tui.output.waitFor(listed, "the agents");
  let screen = await select(tui, "Codex CLI");
  assert.match(selected(screen), /Codex CLI +! no key/);
  assert.match(screen, /Wired without a Gateway Key .*; R gives it one\./);
  assert.match(screen, /R new key/);
  screen = await tui.press(
    "R",
    (text) => text.includes("Give Codex CLI a Gateway Key?"),
    "the question",
  );
  assert.match(screen, /Issues Codex CLI its first Gateway Key/);
  // n leaves it as it was.
  await tui.press(
    "n",
    (text) => text.includes("Cancelled; nothing was changed."),
    "the cancelled question",
  );
  assert.equal((await on.client.agents.get("codex")).wiring?.keyState, "none");
  await tui.press("R", (text) => text.includes("Gateway Key?"), "the question");
  screen = await tui.press(
    "y",
    (text) => /✓ Codex CLI has key [a-z2-7]{12}\./.test(text),
    "the new key",
  );
  assert.match(selected(screen), /Codex CLI +✓ wired +\[\(its own\)\]/);
  const wiring = (await on.client.agents.get("codex")).wiring;
  assert.equal(wiring?.keyState, "active");
  assert.match(
    await readFile(path.join(on.home, ".codex", "config.toml"), "utf8"),
    new RegExp(`/backend-api/codex/hhk_a_${wiring!.keyId}_`),
  );
  await tui.press("q", () => true, "quit");
  assert.equal(await tui.done, 0);
});

void test("hh tui shows what route groups' rules reach, the automatic groups, and the newer agents as installed or not", async (t) => {
  const on = await machine(t);
  // A rule of length alone sends long requests to the larger model.
  await on.client.routeGroups.create({
    id: "long",
    members: [SMALL, LARGE],
    rules: [{ tokens: 100_000, use: LARGE }],
  });
  // A second provider with a model of the same name makes an automatic group.
  const fake = await startFakeProvider({
    models: ["sim-small"],
    keys: { upstream: KEY },
    chunkDelayMs: 0,
  });
  t.after(() => fake.close());
  await on.client.providers.create({
    id: "mirror",
    kind: "custom",
    endpoints: { chat: `${fake.url}/v1` },
    models: {
      source: "manual",
      list: [{ id: "sim-small", contextWindow: 64_000 }],
      expose: "all",
    },
    credential: { value: KEY },
  });
  // OpenCode is set up, which says nothing about OpenChamber; dsh is.
  await mkdir(path.join(on.home, ".config", "opencode"), { recursive: true });
  await mkdir(path.join(on.home, ".dsh"), { recursive: true });

  const tui = session(on.client, { env: { NO_COLOR: "1" }, rows: 40 });
  let screen = await tui.output.waitFor(listed, "the agents");
  assert.match(screen, /^ {4}DeepSeek Harness +not wired +— +effort —/m);
  assert.doesNotMatch(screen, /^ {4}OpenChamber/m);
  screen = await tui.press(
    "f",
    (text) => /^ {4}OpenChamber +not installed/m.test(text),
    "the unfolded agents",
  );
  for (const name of ["Command Code", "fx", "Muse Code"])
    assert.match(screen, new RegExp(`^ {4}${name} +not installed`, "m"));
  await tui.press("f", (text) => /\d+ not installed:/.test(text), "the fold");

  await select(tui, "Codex CLI");
  screen = await tui.press(
    KEYS.enter,
    (text) => text.includes("❯") && text.includes("Automatic groups"),
    "the model picker",
  );
  assert.match(screen, /group\/fast +order · 2 models · 128K ctx/);
  assert.match(screen, /group\/long +order · 2 models · 1M ctx/);
  assert.match(
    screen,
    /Automatic groups\n {4}group\/\S+ +order · 2 models · 64K ctx/,
  );
  await tui.press(KEYS.escape, (text) => !text.includes("❯"), "the list");
  await tui.press("q", () => true, "quit");
  assert.equal(await tui.done, 0);
});

/** The screen's text with lines joined by spaces, for sentences the screen wrapped. */
function flat(screen: string): string {
  return screen
    .split("\n")
    .map((line) => line.trim())
    .join(" ")
    .replace(/ +/g, " ");
}

void test("hh tui shows each agent's notice around a write, and Claude Code's managed settings on its row and status line", async (t) => {
  const on = await machine(t, {
    policy: JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "https://llm-proxy.corp.example" },
    }),
  });
  const before = await readFile(on.policy!.file, "utf8");
  const claude = await on.client.agents.get("claude");
  const codex = await on.client.agents.get("codex");
  assert.match(claude.notice ?? "", /restart/i);
  assert.match(codex.notice ?? "", /restart/i);
  // 80 columns: the notices are longer than a line and are wrapped, not cut.
  const tui = session(on.client, { env: { NO_COLOR: "1" }, columns: 80 });
  await tui.output.waitFor(listed, "the agents");
  await tui.press(KEYS.enter, (text) => text.includes("❯"), "the picker");
  await tui.press(
    "small",
    (text) => text.includes("❯ small") && !text.includes(LARGE),
    "the filtered models",
  );
  let screen = await tui.press(
    KEYS.enter,
    (text) => text.includes("Write these changes"),
    "the plan",
  );
  // The preview warns about the policy and says what to do after writing.
  screen = await tui.press(
    KEYS.pageDown + KEYS.pageDown + KEYS.pageDown,
    (text) => text.includes("After writing:"),
    "the end of the plan",
  );
  assert.ok(
    flat(screen).includes(
      `Warning: ${on.policy!.shown} (an administrator's managed settings) sets env.ANTHROPIC_BASE_URL, which wins over the wiring.`,
    ),
    flat(screen),
  );
  assert.ok(
    flat(screen).includes(`After writing: ${claude.notice}`),
    flat(screen),
  );
  screen = await tui.press(
    "y",
    (text) => text.includes("✓ Claude Code: model fake/sim-small."),
    "the wired agent",
  );
  assert.ok(
    flat(screen).includes(
      `Claude Code: model fake/sim-small. ${claude.notice}`,
    ),
    flat(screen),
  );
  assert.doesNotMatch(screen, /Restart running/);
  // The row marks the policy; the status line names the file and its entries.
  assert.match(selected(screen), /Claude Code +! managed/);
  screen = await tui.press(
    KEYS.right + KEYS.left,
    (text) => text.includes("Managed settings win over the wiring"),
    "the status line",
  );
  assert.ok(
    flat(screen).includes(
      `Managed settings win over the wiring: ${on.policy!.shown} sets env.ANTHROPIC_BASE_URL.`,
    ),
    flat(screen),
  );
  // Unwiring says the same before and after.
  screen = await tui.press(
    "u",
    (text) => text.includes("Unwire Claude Code"),
    "the unwire question",
  );
  assert.ok(flat(screen).includes(`After writing: ${claude.notice}`));
  screen = await tui.press(
    "y",
    (text) => text.includes("✓ Unwired Claude Code"),
    "the unwired agent",
  );
  assert.ok(flat(screen).includes(claude.notice!), flat(screen));
  // Codex's own words after its write.
  await select(tui, "Codex CLI");
  await tui.press(KEYS.enter, (text) => text.includes("❯"), "the picker");
  await tui.press(
    "small",
    (text) => text.includes("❯ small") && !text.includes(LARGE),
    "the filtered models",
  );
  await tui.press(
    KEYS.enter,
    (text) => text.includes("Write these changes"),
    "the plan",
  );
  screen = await tui.press(
    "y",
    (text) => text.includes("✓ Codex CLI: model fake/sim-small."),
    "the wired Codex",
  );
  assert.ok(
    flat(screen).includes(`Codex CLI: model fake/sim-small. ${codex.notice}`),
    flat(screen),
  );
  assert.match(selected(screen), /Codex CLI +✓ wired/, "no policy for Codex");
  // Read only: the policy is as it was.
  assert.equal(await readFile(on.policy!.file, "utf8"), before);
  await tui.press("q", () => true, "quit");
  assert.equal(await tui.done, 0);
  assertRestored(tui);
});

void test("an agent without words of its own gets the same restart line from the TUI and from hh wire, and one that reloads by itself gets none", async (t) => {
  const on = await machine(t, { commands: ["pi"] });
  const pi = await on.client.agents.get("pi");
  assert.equal(
    pi.notice,
    "Restart running Pi sessions to use the new configuration.",
  );
  // WorkBuddy and T3 Code pick a change up on their own.
  for (const id of ["workbuddy", "t3code"])
    assert.equal((await on.client.agents.get(id)).notice, undefined, id);

  const tui = session(on.client, { env: { NO_COLOR: "1" } });
  await tui.output.waitFor(listed, "the agents");
  await select(tui, "Pi");
  await tui.press(KEYS.enter, (text) => text.includes("❯"), "the picker");
  await tui.press(
    "small",
    (text) => text.includes("❯ small") && !text.includes(LARGE),
    "the filtered models",
  );
  let screen = await tui.press(
    KEYS.enter,
    (text) => text.includes("Write these changes"),
    "the plan",
  );
  screen = await tui.press(
    KEYS.pageDown + KEYS.pageDown + KEYS.pageDown,
    (text) => text.includes("After writing:"),
    "the end of the plan",
  );
  assert.ok(flat(screen).includes(`After writing: ${pi.notice}`));
  screen = await tui.press(
    "y",
    (text) => text.includes("✓ Pi: model fake/sim-small."),
    "the wired agent",
  );
  assert.ok(
    flat(screen).includes(`Pi: model fake/sim-small. ${pi.notice}`),
    flat(screen),
  );
  await tui.press("q", () => true, "quit");
  assert.equal(await tui.done, 0);

  // The real hh wire prints the very same line, once.
  const wired = await hh(on, ["wire", "pi", LARGE, "--yes"]);
  assert.equal(wired.code, 0, wired.stderr);
  assert.equal(wired.stdout.split(pi.notice!).length, 2, wired.stdout);
});

void test("hh tui --help names every key the agent list offers", async (t) => {
  const on = await machine(t);
  const tui = session(on.client, { env: { NO_COLOR: "1" }, columns: 160 });
  const screen = await tui.output.waitFor(listed, "the agents");
  await tui.press("q", () => true, "quit");
  assert.equal(await tui.done, 0);
  // The hint lines: "key what  ·  key what …".
  const keys = screen
    .split("\n")
    .filter((line) => line.includes("  ·  "))
    .flatMap((line) => line.trim().split("  ·  "))
    .map((hint) => hint.split(" ")[0]!);
  assert.ok(keys.includes("R"), keys.join(" "));
  const help = await hh(on, ["tui", "--help"]);
  assert.equal(help.code, 0, help.stderr);
  for (const key of keys)
    assert.match(
      help.stdout,
      new RegExp(
        `(^|[\\s(,])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s,]`,
      ),
      `hh tui --help mentions ${key}`,
    );
});

/** Runs the real `hh` launcher against `on`'s daemon, never interactive. */
function hh(
  on: Machine,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(HH_ENTRY),
        ...args,
        "--url",
        on.url,
        "--data-dir",
        on.dataDir,
      ],
      { cwd: on.directory, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr }),
    );
    child.stdin.end("");
  });
}
