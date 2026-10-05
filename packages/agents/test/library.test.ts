// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { LibraryError } from "../src/library/errors.js";
import { applyLibrarySync, SKILL_MARKER } from "../src/library/sync.js";
import { libraryTarget } from "../src/library/targets.js";
import { adapterEnvironment } from "../src/wiring/operations.js";
import { LIBRARY_GOLDEN } from "./library-golden.js";
import {
  addFixtureItems,
  ALL,
  EXISTING_LIBRARY,
  librarySandbox,
  librarySources,
  syntheticSecret,
  tree,
  writeSkill,
} from "./library-support.js";
import { writeFiles } from "./wiring-support.js";

/** Every file under `directory` with its bytes and mode, and every directory. */
async function bytes(directory: string) {
  const result: Record<string, { bytes: Buffer; mode: number } | "dir"> = {};
  for (const entry of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    const file = path.join(entry.parentPath, entry.name);
    const key = path.relative(directory, file);
    if (entry.isDirectory()) result[key] = "dir";
    else if (entry.isSymbolicLink())
      result[key] = { bytes: Buffer.from(await readlink(file)), mode: 0 };
    else
      result[key] = {
        bytes: await readFile(file),
        mode: (await lstat(file)).mode & 0o777,
      };
  }
  return result;
}

/** Removes every item of the Library, so the next sync takes everything out. */
async function emptyLibrary(
  store: Awaited<ReturnType<typeof librarySandbox>>["store"],
) {
  const index = await store.index();
  for (const item of index.instructions)
    await store.remove("instructions", item.id);
  for (const item of index.mcp) await store.remove("mcp", item.name);
  for (const item of index.skills) await store.remove("skills", item.name);
}

for (const agent of ALL)
  for (const mode of ["empty", "existing"] as const)
    void test(`library: ${agent} writes the reviewed output into ${mode === "empty" ? "an empty home" : "existing configuration"}`, async (t) => {
      const box = await librarySandbox(t);
      await addFixtureItems(box.store, box.context.root, [agent]);
      if (mode === "existing")
        await writeFiles(box.context.home, EXISTING_LIBRARY[agent]);
      const plan = await box.plan({ agents: [agent] });
      assert.equal(plan.agents.length, 1);
      assert.ok(plan.changed);
      // Planning writes nothing.
      assert.deepEqual(
        await tree(box.context.home, box.context.dataDir),
        mode === "empty" ? {} : EXISTING_LIBRARY[agent],
      );
      const result = await box.apply({ agents: [agent] });
      const view = result.agents[0]!;
      assert.deepEqual(
        await tree(box.context.home, box.context.dataDir),
        LIBRARY_GOLDEN[agent][mode].files,
      );
      assert.deepEqual(
        view.refused.map((item) => `${item.kind}:${item.name}`),
        LIBRARY_GOLDEN[agent][mode].refused,
      );
      // No secret value reached a file, and a second sync changes nothing.
      for (const text of Object.values(LIBRARY_GOLDEN[agent][mode].files))
        assert.doesNotMatch(text, /synthetic-/);
      const again = await box.plan({ agents: [agent] });
      assert.equal(again.changed, false);
      assert.deepEqual(
        again.agents[0]!.files.map((file) => file.action).filter(
          (action) => action !== "unchanged",
        ),
        [],
      );
    });

for (const agent of ALL)
  void test(`library: taking everything out of ${agent} restores the user's files byte for byte`, async (t) => {
    const box = await librarySandbox(t);
    await addFixtureItems(box.store, box.context.root, [agent]);
    await writeFiles(box.context.home, EXISTING_LIBRARY[agent]);
    const before = await bytes(box.context.home);
    await box.apply({ agents: [agent], allowPlaintextSecret: true });
    assert.notDeepEqual(await bytes(box.context.home), before);
    await emptyLibrary(box.store);
    const plan = await box.plan({ agents: [agent] });
    assert.ok(
      plan.agents[0]!.files.every((file) => file.action === "restore"),
      JSON.stringify(plan.agents[0]!.files.map((file) => file.action)),
    );
    await box.apply({ agents: [agent] });
    assert.deepEqual(await bytes(box.context.home), before);
    assert.deepEqual((await box.store.applied()).agents, {});
  });

for (const agent of ALL)
  void test(`library: taking everything out of ${agent} leaves an empty home empty`, async (t) => {
    const box = await librarySandbox(t);
    await addFixtureItems(box.store, box.context.root, [agent]);
    await box.apply({ agents: [agent] });
    await emptyLibrary(box.store);
    await box.apply({ agents: [agent] });
    assert.deepEqual(await readdir(box.context.home), []);
  });

void test("library: removal after the user edited a file takes out only the Library's part", async (t) => {
  const box = await librarySandbox(t);
  await addFixtureItems(box.store, box.context.root, ["claude"]);
  await writeFiles(box.context.home, EXISTING_LIBRARY.claude);
  await box.apply({ agents: ["claude"] });
  const config = path.join(box.context.home, ".claude.json");
  const notes = path.join(box.context.home, ".claude", "CLAUDE.md");
  await writeFile(
    config,
    (await readFile(config, "utf8")).replace(
      '"numStartups": 4',
      '"numStartups": 5',
    ),
  );
  await writeFile(notes, `# Added later\n\n${await readFile(notes, "utf8")}`);
  await emptyLibrary(box.store);
  const plan = await box.plan({ agents: ["claude"] });
  assert.deepEqual(
    plan.agents[0]!.files.map((file) => file.action),
    ["write", "write"],
  );
  await box.apply({ agents: ["claude"] });
  assert.equal(
    await readFile(notes, "utf8"),
    "# Added later\n\n# My notes\n\nPrefer small diffs.\n",
  );
  assert.equal(
    await readFile(config, "utf8"),
    `{
  "numStartups": 5,
  "mcpServers": {
    "mine": { "command": "my-mcp" }
  }
}
`,
  );
  // A later sync of new items starts from the user's current text.
  assert.deepEqual((await box.store.applied()).agents, {});
});

void test("library: a server of the same name that is the user's is refused and kept", async (t) => {
  const box = await librarySandbox(t);
  await addFixtureItems(box.store, box.context.root, ["opencode"]);
  const original = `{
  "mcp": {
    "files": { "type": "local", "command": ["their-files"] }
  }
}
`;
  await writeFiles(box.context.home, {
    ".config/opencode/opencode.json": original,
  });
  const result = await box.apply({ agents: ["opencode"] });
  assert.ok(
    result.agents[0]!.refused.some(
      (item) => item.name === "files" && /the user's/.test(item.reason),
    ),
  );
  const written = JSON.parse(
    await readFile(
      path.join(box.context.home, ".config/opencode/opencode.json"),
      "utf8",
    ),
  ) as { mcp: Record<string, unknown> };
  assert.deepEqual(written.mcp.files, {
    type: "local",
    command: ["their-files"],
  });
  assert.ok(written.mcp.docs);
  await emptyLibrary(box.store);
  await box.apply({ agents: ["opencode"] });
  assert.equal(
    await readFile(
      path.join(box.context.home, ".config/opencode/opencode.json"),
      "utf8",
    ),
    original,
  );
});

void test("library: instruction blocks keep CRLF, update in place and warn when edited by hand", async (t) => {
  const box = await librarySandbox(t);
  await box.store.putInstructionSet("team", {
    name: "Team",
    text: "First rule.",
    agents: ["gemini"],
  });
  const file = path.join(box.context.home, ".gemini", "GEMINI.md");
  await writeFiles(box.context.home, { ".gemini/GEMINI.md": "Mine.\r\n" });
  await box.apply({ agents: ["gemini"] });
  await writeFile(file, `${await readFile(file, "utf8")}After.\r\n`);
  await box.store.putInstructionSet("team", {
    name: "Team",
    text: "Second rule.",
    agents: ["gemini"],
  });
  await box.apply({ agents: ["gemini"] });
  const text = await readFile(file, "utf8");
  assert.match(
    text,
    /^Mine\.\r\n\r\n<!-- harnesshub:begin id=team sha=[0-9a-f]{64} -->\r\nSecond rule\.\r\n<!-- harnesshub:end -->\r\nAfter\.\r\n$/,
  );
  await writeFile(file, text.replace("Second rule.", "Second rule, edited."));
  const plan = await box.plan({ agents: ["gemini"] });
  assert.ok(
    plan.agents[0]!.warnings.some((warning) => /edited by hand/.test(warning)),
  );
  await emptyLibrary(box.store);
  await box.apply({ agents: ["gemini"] });
  assert.equal(await readFile(file, "utf8"), "Mine.\r\n\r\nAfter.\r\n");
});

void test("library: Codex's AGENTS.override.md is reported", async (t) => {
  const box = await librarySandbox(t);
  await box.store.putInstructionSet("team", {
    name: "Team",
    text: "Rule.",
    agents: ["codex"],
  });
  await writeFiles(box.context.home, {
    ".codex/AGENTS.override.md": "Override.\n",
  });
  const plan = await box.plan({ agents: ["codex"] });
  assert.ok(
    plan.agents[0]!.warnings.some((warning) =>
      /AGENTS\.override\.md/.test(warning),
    ),
  );
});

void test("library: an instruction set cannot go to an agent without an instructions file", async (t) => {
  const box = await librarySandbox(t);
  await assert.rejects(
    box.store.putInstructionSet("team", {
      name: "Team",
      text: "Rule.",
      agents: ["kimi"],
    }),
    (error: unknown) =>
      error instanceof LibraryError && error.code === "LIBRARY_UNSUPPORTED",
  );
  await box.store.putInstructionSet("team", {
    name: "Team",
    text: "Rule.",
    agents: ["claude"],
  });
  await assert.rejects(
    box.store.putInstructionSet("other", {
      name: "Other",
      text: "Rule.",
      agents: ["claude"],
    }),
    (error: unknown) =>
      error instanceof LibraryError && error.code === "LIBRARY_CONFLICT",
  );
});

void test("library: secrets an agent cannot reference are refused unless values may be written", async (t) => {
  const box = await librarySandbox(t);
  await box.store.putMcpServer({
    name: "github",
    transport: "stdio",
    command: "github-mcp",
    secretEnv: { GITHUB_TOKEN: { kind: "env", value: "GITHUB_TOKEN" } },
    agents: ["kimi", "claude"],
  });
  const refused = await box.plan({ agents: ["kimi"] });
  assert.match(
    refused.agents[0]!.refused[0]!.reason,
    /allow writing secret values/,
  );
  assert.deepEqual(refused.agents[0]!.files, []);

  const plan = await box.plan({ agents: ["kimi"], allowPlaintextSecret: true });
  const diff = plan.agents[0]!.files[0]!.diff;
  assert.match(diff, /"GITHUB_TOKEN": "<secret>"/);
  assert.doesNotMatch(diff, /synthetic-/);
  assert.ok(
    plan.agents[0]!.warnings.some((warning) => /plain text/.test(warning)),
  );
  await box.apply({ agents: ["kimi"], allowPlaintextSecret: true });
  const written = await readFile(
    path.join(box.context.home, ".kimi", "mcp.json"),
    "utf8",
  );
  assert.match(written, new RegExp(syntheticSecret("GITHUB_TOKEN")));

  // Claude Code references the variable; consent changes nothing there.
  await box.apply({ agents: ["claude"], allowPlaintextSecret: true });
  const claude = await readFile(
    path.join(box.context.home, ".claude.json"),
    "utf8",
  );
  assert.match(claude, /"GITHUB_TOKEN": "\$\{GITHUB_TOKEN\}"/);
  assert.doesNotMatch(claude, /synthetic-/);
});

void test("library: a store secret, or Codex's renamed variable, is not referable", async (t) => {
  const box = await librarySandbox(t);
  await box.store.putMcpServer({
    name: "stored",
    transport: "stdio",
    command: "tool",
    secretEnv: { TOKEN: { kind: "store", value: "mcp-stored-token" } },
    agents: ["claude"],
  });
  await box.store.putMcpServer({
    name: "renamed",
    transport: "stdio",
    command: "tool",
    secretEnv: { API_KEY: { kind: "env", value: "MY_API_KEY" } },
    agents: ["codex"],
  });
  const plan = await box.plan({ agents: ["claude", "codex"] });
  assert.match(plan.agents[0]!.refused[0]!.reason, /store secret/);
  assert.match(plan.agents[1]!.refused[0]!.reason, /own name/);
});

void test("library: references to HarnessHub credentials are refused (SECRET_REF_FORBIDDEN)", async (t) => {
  const box = await librarySandbox(t);
  await box.store.putMcpServer({
    name: "leaky",
    transport: "stdio",
    command: "tool",
    secretEnv: { OPENAI_API_KEY: { kind: "env", value: "HH_PROVIDER_KEY" } },
    agents: ["claude", "kimi"],
  });
  const io = librarySources(box.store, {
    forbiddenRef: (ref) =>
      Promise.resolve(
        ref.value.startsWith("HH_")
          ? "HH_ variables are HarnessHub's own"
          : undefined,
      ),
  });
  const result = await box.apply({ allowPlaintextSecret: true }, io);
  for (const agent of result.agents.filter(
    (item) => item.agent === "claude" || item.agent === "kimi",
  ))
    assert.match(agent.refused[0]!.reason, /^SECRET_REF_FORBIDDEN/);
  assert.deepEqual(await readdir(box.context.home), []);
});

void test("library: a value that is a HarnessHub credential is never written as plain text", async (t) => {
  const box = await librarySandbox(t);
  await box.store.putMcpServer({
    name: "leaky",
    transport: "stdio",
    command: "tool",
    secretEnv: { TOKEN: { kind: "file", value: "/secrets/token" } },
    agents: ["kimi"],
  });
  const io = librarySources(box.store, {
    forbiddenValue: (value) =>
      Promise.resolve(value === syntheticSecret("/secrets/token")),
  });
  const plan = await box.plan(
    { agents: ["kimi"], allowPlaintextSecret: true },
    io,
  );
  assert.match(plan.agents[0]!.refused[0]!.reason, /HarnessHub credential/);
});

void test("library: a skill round-trips as a link, and is replaced when updated", async (t) => {
  const box = await librarySandbox(t);
  const source = await writeSkill(
    path.join(box.context.root, "src"),
    "pdf-tools",
    "PDFs.",
  );
  const first = await box.store.importSkill(source, ["claude", "kimi"]);
  await box.apply();
  const placed = path.join(box.context.home, ".claude", "skills", "pdf-tools");
  assert.ok((await lstat(placed)).isSymbolicLink());
  assert.equal(
    await readlink(placed),
    box.store.skillDirectory(first.sha256, "pdf-tools"),
  );
  assert.match(
    await readFile(path.join(placed, "SKILL.md"), "utf8"),
    /name: pdf-tools/,
  );
  assert.ok(
    ((await stat(path.join(placed, "scripts", "run.sh"))).mode & 0o100) !== 0,
  );

  await writeFile(
    path.join(source, "SKILL.md"),
    "---\nname: pdf-tools\ndescription: PDFs, v2.\n---\n",
  );
  // A skill of the same name is replaced only when that is asked for.
  await assert.rejects(box.store.importSkill(source, ["claude", "kimi"]), {
    code: "LIBRARY_EXISTS",
  });
  const second = await box.store.importSkill(source, ["claude", "kimi"], {
    replace: true,
  });
  assert.notEqual(second.sha256, first.sha256);
  const plan = await box.plan({ agents: ["claude"] });
  assert.deepEqual(
    plan.agents[0]!.skills.map((skill) => skill.action),
    ["replace"],
  );
  await box.apply();
  assert.equal(
    await readlink(placed),
    box.store.skillDirectory(second.sha256, "pdf-tools"),
  );
  await box.store.collect();
  assert.deepEqual(await readdir(path.join(box.store.directory, "skills")), [
    second.sha256,
  ]);

  await box.store.remove("skills", "pdf-tools");
  await box.apply();
  assert.deepEqual(await readdir(box.context.home), []);
  await box.store.collect();
  assert.deepEqual(await readdir(path.join(box.store.directory, "skills")), []);
});

void test("library: a copied skill carries its marker and goes when unassigned; an edited copy stays", async (t) => {
  const box = await librarySandbox(t);
  const source = await writeSkill(
    path.join(box.context.root, "src"),
    "pdf-tools",
    "PDFs.",
  );
  const skill = await box.store.importSkill(source, ["gemini", "qwen"]);
  await box.apply({ placement: "copy" });
  for (const agent of [".gemini", ".qwen"]) {
    const placed = path.join(box.context.home, agent, "skills", "pdf-tools");
    assert.ok((await lstat(placed)).isDirectory());
    assert.equal(
      (
        JSON.parse(await readFile(path.join(placed, SKILL_MARKER), "utf8")) as {
          sha256: string;
        }
      ).sha256,
      skill.sha256,
    );
    assert.equal(
      await readFile(path.join(placed, "scripts", "run.sh"), "utf8"),
      await readFile(path.join(source, "scripts", "run.sh"), "utf8"),
    );
  }
  // The user edits the Qwen copy: it is theirs from then on.
  await writeFile(
    path.join(box.context.home, ".qwen", "skills", "pdf-tools", "notes.md"),
    "mine\n",
  );
  assert.equal((await box.plan()).changed, false);
  await box.store.remove("skills", "pdf-tools");
  const plan = await box.plan();
  const qwen = plan.agents.find((agent) => agent.agent === "qwen")!;
  assert.deepEqual(qwen.skills, []);
  assert.ok(qwen.warnings.some((warning) => /changed by hand/.test(warning)));
  await box.apply();
  assert.deepEqual(
    await readdir(path.join(box.context.home, ".gemini")).catch(() => []),
    [],
  );
  assert.deepEqual(
    (
      await readdir(path.join(box.context.home, ".qwen", "skills", "pdf-tools"))
    ).sort(),
    [SKILL_MARKER, "SKILL.md", "notes.md", "scripts"].sort(),
  );
  assert.deepEqual((await box.store.applied()).agents, {});
});

void test("library: a skill directory of the user's with the same name is refused", async (t) => {
  const box = await librarySandbox(t);
  const source = await writeSkill(
    path.join(box.context.root, "src"),
    "pdf-tools",
    "PDFs.",
  );
  await box.store.importSkill(source, ["codex"]);
  await writeFiles(box.context.home, {
    ".codex/skills/pdf-tools/SKILL.md": "mine\n",
  });
  const result = await box.apply({ agents: ["codex"] });
  assert.match(result.agents[0]!.refused[0]!.reason, /not the Library's/);
  assert.equal(
    await readFile(
      path.join(box.context.home, ".codex/skills/pdf-tools/SKILL.md"),
      "utf8",
    ),
    "mine\n",
  );
});

void test("library: a file changed after the plan fails the apply and nothing is written", async (t) => {
  const box = await librarySandbox(t);
  await addFixtureItems(box.store, box.context.root, ["claude"]);
  await writeFiles(box.context.home, EXISTING_LIBRARY.claude);
  const plan = await box.plan({ agents: ["claude"] });
  await writeFile(
    path.join(box.context.home, ".claude.json"),
    '{ "numStartups": 9 }\n',
  );
  const before = await bytes(box.context.home);
  await assert.rejects(
    box.apply({ agents: ["claude"], expect: plan }),
    (error: unknown) =>
      error instanceof LibraryError &&
      error.code === "LIBRARY_CONCURRENT_MODIFICATION",
  );
  assert.deepEqual(await bytes(box.context.home), before);
});

void test("library: a failure to save the state restores the agent's files", async (t) => {
  const box = await librarySandbox(t);
  await addFixtureItems(box.store, box.context.root, ["claude"]);
  await writeFiles(box.context.home, EXISTING_LIBRARY.claude);
  const before = await bytes(box.context.home);
  await assert.rejects(
    applyLibrarySync(
      await box.store.index(),
      await box.store.applied(),
      box.sources,
      box.context,
      {
        agents: ["claude"],
        persist: () => Promise.reject(new Error("disk full")),
      },
    ),
    /disk full/,
  );
  assert.deepEqual(await bytes(box.context.home), before);
});

void test("library: when an agent's directory moves, the old files are taken out and the new ones written", async (t) => {
  const box = await librarySandbox(t);
  await addFixtureItems(box.store, box.context.root, ["claude"]);
  await writeFiles(box.context.home, EXISTING_LIBRARY.claude);
  const before = await bytes(box.context.home);
  await box.apply({ agents: ["claude"] });
  const config = path.join(box.context.root, "claude-config");
  await mkdir(config);
  const moved = { ...box.context, env: { CLAUDE_CONFIG_DIR: config } };
  await applyLibrarySync(
    await box.store.index(),
    await box.store.applied(),
    box.sources,
    moved,
    {
      agents: ["claude"],
      persist: (state) => box.store.saveApplied(state),
    },
  );
  // The home is as it was; everything is in the new directory.
  assert.deepEqual(await bytes(box.context.home), before);
  assert.deepEqual((await readdir(config)).sort(), [
    ".claude.json",
    "CLAUDE.md",
    "skills",
  ]);
});

void test("library: targets follow the agents' directory variables", async (t) => {
  const box = await librarySandbox(t);
  const config = path.join(box.context.root, "claude-config");
  const xdg = path.join(box.context.root, "xdg");
  await mkdir(config);
  const environment = adapterEnvironment({
    ...box.context,
    env: {
      CLAUDE_CONFIG_DIR: config,
      XDG_CONFIG_HOME: xdg,
      HERMES_HOME: path.join(box.context.root, "hermes"),
    },
  });
  const claude = libraryTarget("claude", environment);
  assert.equal(
    claude.instructions?.file.create,
    path.join(config, "CLAUDE.md"),
  );
  assert.equal(claude.mcp?.file.create, path.join(config, ".claude.json"));
  assert.equal(claude.skills?.directory, path.join(config, "skills"));
  assert.equal(
    libraryTarget("crush", environment).instructions?.file.create,
    path.join(xdg, "crush", "CRUSH.md"),
  );
  assert.equal(
    libraryTarget("hermes", environment).skills?.directory,
    path.join(box.context.root, "hermes", "skills"),
  );
});
