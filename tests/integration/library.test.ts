// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { startHub } from "@harnesshub/daemon/main";
import { HarnessHubError } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
import { temporaryDirectory } from "../support/temporary.js";

/** Synthetic values only; none is a real credential. */
const PROVIDER_KEY = "sk-synthetic-library-provider-0001";
const SEARCH_TOKEN = "synthetic-search-token-0001";
const CODEX_CONFIG = `# my Codex settings
model = "o3" # mine
`;

function problem(code: string, status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof HarnessHubError, String(error));
    assert.equal(error.code, code, JSON.stringify(error.problem));
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

/** Every file and link under `root` with its content (a link as `-> target`). */
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    const file = path.join(entry.parentPath, entry.name);
    const key = path.relative(root, file);
    if (entry.isSymbolicLink()) result[key] = `-> ${await readlink(file)}`;
    else if (entry.isDirectory()) result[key] = "<dir>";
    else result[key] = await readFile(file, "utf8");
  }
  return result;
}

/**
 * A daemon whose wiring home is a temporary directory with a Codex
 * configuration, and a provider whose credentials are a stored value and
 * an environment variable; nothing reaches a network.
 */
async function setup(t: TestContext, wiring = true) {
  const { directory, defer } = await temporaryDirectory(t, "hh-library-");
  const home = path.join(directory, "home");
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(path.join(home, ".codex", "config.toml"), CODEX_CONFIG);
  const dataDir = path.join(directory, "data");
  const hub = await startHub({
    dataDir,
    configDir: path.join(directory, "config"),
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
    ...(wiring
      ? { wiringHome: { home, env: { PATH: "", SEARCH_TOKEN } } }
      : {}),
  });
  defer(() => hub.server.close());
  const client = await connectLocal({ dataDir, url: hub.url });
  await client.providers.create({
    id: "fake",
    name: "Fake",
    kind: "custom",
    endpoints: { chat: "http://127.0.0.1:9/v1" },
    models: {
      source: "manual",
      list: [{ id: "upstream-sim" }],
      expose: "all",
    },
    credential: { value: PROVIDER_KEY },
  });
  await client.credentials.add("fake", {
    name: "from-env",
    ref: { kind: "env", value: "FAKE_PROVIDER_KEY" },
  });
  const skill = path.join(directory, "skills", "pdf-tools");
  await mkdir(path.join(skill, "scripts"), { recursive: true });
  await writeFile(
    path.join(skill, "SKILL.md"),
    "---\nname: pdf-tools\ndescription: Work with PDF files.\n---\n\nUse scripts/run.sh.\n",
  );
  await writeFile(
    path.join(skill, "scripts", "run.sh"),
    "#!/bin/sh\necho pdf\n",
  );
  await chmod(path.join(skill, "scripts", "run.sh"), 0o755);
  return { client, url: hub.url, home, dataDir, directory, skill };
}

void test("library: items are kept by the daemon, synced into agents and taken out again", async (t) => {
  const { client, home, skill } = await setup(t);
  const before = await snapshot(home);

  const team = await client.library.instructions.create("team", {
    name: "Team rules",
    text: "# Team rules\r\n\r\nRun the tests before you commit.\r\n",
    agents: ["claude", "codex"],
  });
  assert.equal(team.text, "# Team rules\n\nRun the tests before you commit.");
  await assert.rejects(
    client.library.instructions.create("team", { text: "Again." }),
    problem("LIBRARY_EXISTS", 409),
  );
  await assert.rejects(
    client.library.instructions.create("hermes", {
      text: "x",
      agents: ["hermes"],
    }),
    problem("LIBRARY_UNSUPPORTED", 400),
  );
  await client.library.mcp.create("github", {
    transport: "stdio",
    command: "github-mcp",
    args: ["stdio"],
    secretEnv: { GITHUB_TOKEN: { kind: "env", value: "GITHUB_TOKEN" } },
    agents: ["claude", "codex", "kimi"],
  });
  const search = await client.library.mcp.create("search", {
    transport: "http",
    url: "https://mcp.example.test/search",
    secretHeaders: { Authorization: { secret: SEARCH_TOKEN } },
    agents: ["claude"],
  });
  assert.equal(search.secretHeaders?.Authorization?.kind, "store");
  assert.doesNotMatch(JSON.stringify(search), new RegExp(SEARCH_TOKEN));
  assert.doesNotMatch(
    JSON.stringify(await client.library.mcp.list()),
    new RegExp(SEARCH_TOKEN),
  );
  const imported = await client.library.skills.import(skill, ["claude"]);
  assert.equal(imported.files, 2);

  // Without consent, the stored secret is refused for Claude Code and the
  // variable for Kimi; the rest is planned.
  const plan = await client.library.sync.plan();
  const claude = plan.agents.find((agent) => agent.agent === "claude")!;
  assert.deepEqual(
    claude.refused.map((item) => item.name),
    ["search"],
  );
  assert.deepEqual(
    plan.agents
      .find((agent) => agent.agent === "kimi")!
      .refused.map((item) => item.name),
    ["github"],
  );
  assert.deepEqual(await snapshot(home), before);

  const consent = await client.library.sync.plan({
    agents: ["claude", "codex"],
    allowPlaintextSecret: true,
  });
  const diff = consent.agents[0]!.files.find(
    (file) => file.kind === "mcp",
  )!.diff;
  assert.match(diff, /"Authorization": "<secret>"/);
  assert.doesNotMatch(JSON.stringify(consent), new RegExp(SEARCH_TOKEN));
  const applied = await client.library.sync.apply({
    agents: ["claude", "codex"],
    allowPlaintextSecret: true,
    expect: consent,
  });
  assert.ok(applied.changed);
  const claudeJson = await readFile(path.join(home, ".claude.json"), "utf8");
  assert.match(claudeJson, /"GITHUB_TOKEN": "\$\{GITHUB_TOKEN\}"/);
  assert.match(claudeJson, new RegExp(`"Authorization": "${SEARCH_TOKEN}"`));
  assert.match(
    await readFile(path.join(home, ".codex", "config.toml"), "utf8"),
    /^# my Codex settings\nmodel = "o3" # mine\n\n\[mcp_servers\.github\]\ncommand = "github-mcp"\nargs = \["stdio"\]\nenv_vars = \["GITHUB_TOKEN"\]\n$/,
  );
  assert.match(
    await readFile(path.join(home, ".claude", "CLAUDE.md"), "utf8"),
    /^<!-- harnesshub:begin id=team sha=[0-9a-f]{64} -->\n# Team rules\n/,
  );
  const placed = path.join(home, ".claude", "skills", "pdf-tools");
  assert.ok((await lstat(placed)).isSymbolicLink());
  assert.match(
    await readFile(path.join(placed, "SKILL.md"), "utf8"),
    /pdf-tools/,
  );
  assert.equal(
    (
      await client.library.sync.plan({
        agents: ["claude", "codex"],
        allowPlaintextSecret: true,
      })
    ).changed,
    false,
  );

  // A file changed after the plan is not overwritten.
  await client.library.instructions.replace("team", {
    text: "Run the tests.",
    agents: ["claude", "codex"],
  });
  const stale = await client.library.sync.plan({ agents: ["codex"] });
  await writeFile(
    path.join(home, ".codex", "AGENTS.md"),
    `${await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")}Mine.\n`,
  );
  await assert.rejects(
    client.library.sync.apply({ agents: ["codex"], expect: stale }),
    problem("LIBRARY_CONCURRENT_MODIFICATION", 409),
  );
  await writeFile(
    path.join(home, ".codex", "AGENTS.md"),
    (await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).replace(
      "Mine.\n",
      "",
    ),
  );

  // Taking everything out restores the home as it was.
  await client.library.instructions.remove("team");
  await client.library.mcp.remove("github");
  await client.library.mcp.remove("search");
  await client.library.skills.remove("pdf-tools");
  await assert.rejects(
    client.library.mcp.get("search"),
    problem("LIBRARY_NOT_FOUND", 404),
  );
  const out = await client.library.sync.plan();
  await client.library.sync.apply({ expect: out });
  assert.deepEqual(await snapshot(home), before);
});

void test("library: secret references to HarnessHub's credentials are refused (SECRET_REF_FORBIDDEN)", async (t) => {
  const { client, dataDir, directory } = await setup(t);
  const stdio = { transport: "stdio" as const, command: "tool" };
  // A provider credential's variable.
  await assert.rejects(
    client.library.mcp.create("leak-env", {
      ...stdio,
      secretEnv: { API_KEY: { kind: "env", value: "FAKE_PROVIDER_KEY" } },
    }),
    problem("SECRET_REF_FORBIDDEN", 400),
  );
  // HarnessHub's own variables.
  await assert.rejects(
    client.library.mcp.create("leak-hh", {
      ...stdio,
      secretEnv: { TOKEN: { kind: "env", value: "HH_ADMIN_TOKEN" } },
    }),
    problem("SECRET_REF_FORBIDDEN", 400),
  );
  // The admin token and the file backend's master key.
  for (const file of [
    path.join(dataDir, "admin.token"),
    path.join(directory, "config", "secrets.key"),
  ])
    await assert.rejects(
      client.library.mcp.create("leak-file", {
        transport: "http",
        url: "https://mcp.example.test/",
        secretHeaders: { Authorization: { kind: "file", value: file } },
      }),
      problem("SECRET_REF_FORBIDDEN", 400),
    );
  // A provider credential's value, and a Gateway Key, given as values.
  for (const secret of [PROVIDER_KEY, `hhk_a_abcdefghijkl_${"S".repeat(43)}`])
    await assert.rejects(
      client.library.mcp.create("leak-value", {
        ...stdio,
        secretEnv: { TOKEN: { secret } },
      }),
      problem("SECRET_REF_FORBIDDEN", 400),
    );
  // A store reference the server does not hold (a provider credential's id).
  const [credential] = (await client.credentials.list("fake")).items;
  await assert.rejects(
    client.library.mcp.create("leak-store", {
      ...stdio,
      secretEnv: { TOKEN: credential!.ref as { kind: "store"; value: string } },
    }),
    problem("LIBRARY_INVALID", 400),
  );
  // Plain values of credential names belong in secret references.
  await assert.rejects(
    client.library.mcp.create("plain", {
      ...stdio,
      env: { GITHUB_TOKEN: "ghp-synthetic" },
    }),
    problem("LIBRARY_INVALID", 400),
  );
  assert.deepEqual((await client.library.mcp.list()).items, []);
  // A variable of the tool's own is accepted.
  const ok = await client.library.mcp.create("mine", {
    ...stdio,
    secretEnv: { TOKEN: { kind: "env", value: "MY_MCP_TOKEN" } },
    agents: ["claude"],
  });
  assert.deepEqual(ok.secretEnv, {
    TOKEN: { kind: "env", value: "MY_MCP_TOKEN" },
  });
});

void test("library: items are kept without a wiring home; syncing needs one", async (t) => {
  const { client } = await setup(t, false);
  await client.library.instructions.create("team", {
    text: "Rule.",
    agents: ["claude"],
  });
  assert.equal((await client.library.instructions.list()).items.length, 1);
  await assert.rejects(
    client.library.sync.plan(),
    problem("AGENT_WIRING_UNAVAILABLE", 503),
  );
});

void test("library: a skill uploaded as files is validated like a directory import", async (t) => {
  const { client, skill, dataDir } = await setup(t, false);
  const base64 = (text: string) => Buffer.from(text).toString("base64");
  const manifest = base64(
    "---\nname: pdf-tools\ndescription: Work with PDF files.\n---\n\nUse scripts/run.sh.\n",
  );
  const script = base64("#!/bin/sh\necho pdf\n");
  const uploaded = await client.library.skills.upload({
    name: "pdf-tools",
    files: {
      "SKILL.md": manifest,
      "scripts/run.sh": script,
      // What a browser's directory picker may add; a skill directory skips it.
      ".DS_Store": base64("finder"),
    },
    exec: ["scripts/run.sh"],
    agents: ["claude"],
  });
  assert.equal(uploaded.name, "pdf-tools");
  assert.deepEqual(uploaded.agents, ["claude"]);
  // The same content imported from its directory is the same version.
  const imported = await client.library.skills.import(skill, ["claude"]);
  assert.equal(imported.sha256, uploaded.sha256);
  const stored = path.join(
    dataDir,
    "library",
    "skills",
    uploaded.sha256,
    "pdf-tools",
  );
  if (process.platform !== "win32")
    assert.notEqual(
      (await stat(path.join(stored, "scripts", "run.sh"))).mode & 0o100,
      0,
    );

  const refused: Array<[Record<string, unknown>, string]> = [
    [
      { name: "pdf-tools", files: { "../SKILL.md": manifest } },
      "LIBRARY_SKILL_INVALID",
    ],
    [
      {
        name: "pdf-tools",
        files: { "SKILL.md": manifest, "/etc/passwd": script },
      },
      "LIBRARY_SKILL_INVALID",
    ],
    [
      { name: "pdf-tools", files: { "SKILL.md": manifest, "a\\b": script } },
      "LIBRARY_SKILL_INVALID",
    ],
    [
      {
        name: "pdf-tools",
        files: { "SKILL.md": manifest, "scripts/./run.sh": script },
      },
      "LIBRARY_SKILL_INVALID",
    ],
    [
      {
        name: "pdf-tools",
        files: { "SKILL.md": manifest, "x.sh": script, "X.sh": script },
      },
      "LIBRARY_SKILL_INVALID",
    ],
    [
      {
        name: "pdf-tools",
        files: {
          "SKILL.md": manifest,
          scripts: script,
          "scripts/run.sh": script,
        },
      },
      "LIBRARY_SKILL_INVALID",
    ],
    [
      { name: "pdf-tools", files: { "SKILL.md": "not base64!" } },
      "LIBRARY_SKILL_INVALID",
    ],
    [
      { name: "pdf-tools", files: { "SKILL.md": manifest }, exec: ["run.sh"] },
      "LIBRARY_SKILL_INVALID",
    ],
    // The name must be the one the front matter gives.
    [
      { name: "other-tools", files: { "SKILL.md": manifest } },
      "LIBRARY_SKILL_INVALID",
    ],
    [
      { name: "pdf-tools", files: { "notes.md": script } },
      "LIBRARY_SKILL_INVALID",
    ],
    [
      { name: "pdf-tools", files: { "SKILL.md": manifest }, source: skill },
      "LIBRARY_INVALID",
    ],
    [{ files: { "SKILL.md": manifest } }, "LIBRARY_INVALID"],
  ];
  for (const [body, code] of refused)
    await assert.rejects(
      client.library.skills.upload(body as never),
      problem(code, 400),
      JSON.stringify(body).slice(0, 120),
    );
  // Over the 20 MiB limit, before anything is written.
  await assert.rejects(
    client.library.skills.upload({
      name: "pdf-tools",
      files: {
        "SKILL.md": manifest,
        "big.bin": Buffer.alloc(21 * 1024 * 1024).toString("base64"),
      },
    }),
    problem("LIBRARY_SKILL_INVALID", 400),
  );
  const many = Object.fromEntries(
    Array.from({ length: 501 }, (_, index) => [`f${index}.md`, script]),
  );
  await assert.rejects(
    client.library.skills.upload({ name: "pdf-tools", files: many }),
    problem("INVALID_REQUEST", 400),
  );
  // Refused uploads left no staging directory behind.
  const entries = await readdir(path.join(dataDir, "library", "skills"));
  assert.deepEqual(
    entries.filter((name) => name.startsWith(".staging")),
    [],
  );
  assert.deepEqual(
    (await client.library.skills.list()).items.map((item) => item.name),
    ["pdf-tools"],
  );
});

/** Run the real `hh` launcher with `input` on stdin, so it is never interactive. */
function hh(
  cwd: string,
  args: string[],
  input = "",
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(HH_ENTRY), ...args], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

void test("library: hh library add, list, sync and rm", async (t) => {
  const { url, dataDir, directory, home, skill } = await setup(t);
  const common = ["--url", url, "--data-dir", dataDir];
  const notes = path.join(directory, "team.md");
  await writeFile(notes, "Run the tests.\n");
  const before = await snapshot(home);

  const added = [
    await hh(directory, [
      "library",
      "add",
      "instructions",
      "team",
      "--file",
      notes,
      "--agent",
      "gemini,codex",
      ...common,
    ]),
    await hh(directory, [
      "library",
      "add",
      "mcp",
      "search",
      "--http",
      "https://mcp.example.test/search",
      "--secret-header",
      "Authorization=env:SEARCH_TOKEN",
      "--agent",
      "gemini,kimi",
      ...common,
    ]),
    await hh(
      directory,
      [
        "library",
        "add",
        "mcp",
        "stored",
        "--command",
        "tool",
        "--secret-env",
        "TOKEN=stdin",
        ...common,
      ],
      `${SEARCH_TOKEN}\n`,
    ),
    await hh(directory, [
      "library",
      "add",
      "skill",
      path.relative(directory, skill),
      "--agent",
      "gemini",
      ...common,
    ]),
  ];
  for (const result of added) assert.equal(result.code, 0, result.stderr);
  const secretOnCommandLine = await hh(directory, [
    "library",
    "add",
    "mcp",
    "x",
    "--command",
    "tool",
    "--secret-env",
    `TOKEN=${SEARCH_TOKEN}`,
    ...common,
  ]);
  assert.equal(secretOnCommandLine.code, 2);
  assert.match(secretOnCommandLine.stderr, /never go on the command line/);

  const listed = await hh(directory, ["library", "list", "--json", ...common]);
  assert.equal(listed.code, 0, listed.stderr);
  const items = JSON.parse(listed.stdout) as {
    instructions: unknown[];
    mcp: Array<{ name: string; secretEnv?: Record<string, { kind: string }> }>;
    skills: unknown[];
  };
  assert.equal(items.instructions.length, 1);
  assert.deepEqual(
    items.mcp.map((item) => item.name),
    ["search", "stored"],
  );
  assert.equal(items.mcp[1]!.secretEnv!.TOKEN!.kind, "store");
  assert.equal(items.skills.length, 1);
  assert.doesNotMatch(listed.stdout, new RegExp(SEARCH_TOKEN));

  // Without --yes there is no terminal to ask: nothing is written.
  const unconfirmed = await hh(directory, ["library", "sync", ...common]);
  assert.equal(unconfirmed.code, 4, unconfirmed.stderr);
  assert.deepEqual(await snapshot(home), before);

  // Kimi cannot reference the stored secret: refused, exit 5, the rest synced.
  const synced = await hh(directory, ["library", "sync", "--yes", ...common]);
  assert.equal(synced.code, 5, synced.stderr);
  assert.match(synced.stdout, /Create .*GEMINI\.md/);
  assert.match(synced.stderr, /kimi: mcp search/);
  assert.match(
    await readFile(path.join(home, ".gemini", "settings.json"), "utf8"),
    /"Authorization": "\$\{SEARCH_TOKEN\}"/,
  );
  assert.ok(
    (
      await lstat(path.join(home, ".gemini", "skills", "pdf-tools"))
    ).isSymbolicLink(),
  );

  for (const [kind, name] of [
    ["instructions", "team"],
    ["mcp", "search"],
    ["mcp", "stored"],
    ["skill", "pdf-tools"],
  ] as const) {
    const removed = await hh(directory, [
      "library",
      "rm",
      kind,
      name,
      ...common,
    ]);
    assert.equal(removed.code, 0, removed.stderr);
  }
  const out = await hh(directory, ["library", "sync", "--yes", ...common]);
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(await snapshot(home), before);
});
