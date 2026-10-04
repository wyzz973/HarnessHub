// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { LibraryError } from "../src/library/errors.js";
import {
  parseInstructionSet,
  parseMcpServer,
  readSkill,
} from "../src/library/validate.js";
import { writeSkill } from "./library-support.js";
import { sandbox } from "./wiring-support.js";

function fails(code: string, pattern?: RegExp) {
  return (error: unknown) =>
    error instanceof LibraryError &&
    error.code === code &&
    (pattern === undefined || pattern.test(error.message));
}

void test("library validation: a valid stdio and http server parse", () => {
  assert.deepEqual(
    parseMcpServer(
      {
        transport: "stdio",
        command: "npx",
        args: ["-y", "tool"],
        env: {
          LOG_LEVEL: "info",
          GOOGLE_APPLICATION_CREDENTIALS: "/etc/gcp.json",
        },
        secretEnv: { GITHUB_TOKEN: { kind: "env", value: "GITHUB_TOKEN" } },
        agents: ["claude", "codex"],
      },
      "github",
    ),
    {
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "tool"],
      env: {
        LOG_LEVEL: "info",
        GOOGLE_APPLICATION_CREDENTIALS: "/etc/gcp.json",
      },
      secretEnv: { GITHUB_TOKEN: { kind: "env", value: "GITHUB_TOKEN" } },
      agents: ["claude", "codex"],
    },
  );
  assert.deepEqual(
    parseMcpServer(
      {
        transport: "sse",
        url: "https://mcp.example.test/sse?region=eu",
        secretHeaders: {
          Authorization: { kind: "file", value: "/run/secrets/mcp" },
        },
      },
      "events",
    ),
    {
      name: "events",
      transport: "sse",
      url: "https://mcp.example.test/sse?region=eu",
      secretHeaders: {
        Authorization: { kind: "file", value: "/run/secrets/mcp" },
      },
      agents: [],
    },
  );
});

void test("library validation: invalid MCP servers are rejected", () => {
  const stdio = { transport: "stdio", command: "tool" };
  const http = { transport: "http", url: "https://mcp.example.test/" };
  const cases: Array<[string, unknown, string, RegExp]> = [
    ["bad name", stdio, "LIBRARY_INVALID", /server name/],
    [
      "unknown field",
      { ...stdio, cwd: "/srv" },
      "LIBRARY_INVALID",
      /cwd is not a field/,
    ],
    [
      "transport",
      { ...stdio, transport: "ws" },
      "LIBRARY_INVALID",
      /transport/,
    ],
    [
      "stdio without command",
      { transport: "stdio" },
      "LIBRARY_INVALID",
      /command/,
    ],
    [
      "stdio with url",
      { ...stdio, url: "https://x.test" },
      "LIBRARY_INVALID",
      /not a URL/,
    ],
    [
      "http with command",
      { ...http, command: "tool" },
      "LIBRARY_INVALID",
      /not a command/,
    ],
    [
      "url with credentials",
      { ...http, url: "https://user:pw@x.test/" },
      "LIBRARY_INVALID",
      /without credentials/,
    ],
    [
      "url scheme",
      { ...http, url: "ftp://x.test/" },
      "LIBRARY_INVALID",
      /http\(s\)/,
    ],
    [
      "url key parameter",
      { ...http, url: "https://x.test/?api_key=abc" },
      "LIBRARY_INVALID",
      /secret header/,
    ],
    [
      "env name",
      { ...stdio, env: { log_level: "info" } },
      "LIBRARY_INVALID",
      /invalid name/,
    ],
    [
      "plain token",
      { ...stdio, env: { GITHUB_TOKEN: "ghp" } },
      "LIBRARY_INVALID",
      /secretEnv/,
    ],
    [
      "plain authorization",
      { ...http, headers: { Authorization: "Bearer x" } },
      "LIBRARY_INVALID",
      /secretHeaders/,
    ],
    [
      "secret value",
      { ...stdio, secretEnv: { TOKEN: { kind: "value", value: "x" } } },
      "LIBRARY_INVALID",
      /secret reference/,
    ],
    [
      "secret extra field",
      {
        ...stdio,
        secretEnv: { TOKEN: { kind: "env", value: "T", secret: "x" } },
      },
      "LIBRARY_INVALID",
      /secret reference/,
    ],
    [
      "relative file",
      { ...stdio, secretEnv: { TOKEN: { kind: "file", value: "token" } } },
      "LIBRARY_INVALID",
      /absolute/,
    ],
    [
      "env and secretEnv",
      {
        ...stdio,
        env: { MODE: "a" },
        secretEnv: { MODE: { kind: "env", value: "MODE" } },
      },
      "LIBRARY_INVALID",
      /both/,
    ],
    ["args", { ...stdio, args: "a b" }, "LIBRARY_INVALID", /args/],
    [
      "unknown agent",
      { ...stdio, agents: ["cursor"] },
      "LIBRARY_INVALID",
      /not an agent/,
    ],
    [
      "unsupported transport",
      { transport: "sse", url: "https://x.test/", agents: ["codex"] },
      "LIBRARY_UNSUPPORTED",
      /sse/,
    ],
  ];
  for (const [label, input, code, pattern] of cases)
    assert.throws(
      () => parseMcpServer(input, label === "bad name" ? "bad name" : "server"),
      fails(code, pattern),
      label,
    );
});

void test("library validation: invalid instruction sets are rejected", () => {
  assert.deepEqual(
    parseInstructionSet({ text: "Rule.\r\n", agents: ["pi"] }, "team"),
    {
      name: "team",
      text: "Rule.",
      agents: ["pi"],
    },
  );
  assert.throws(
    () => parseInstructionSet({ text: "x" }, "Team"),
    fails("LIBRARY_INVALID", /id/),
  );
  assert.throws(
    () => parseInstructionSet({ text: "  " }, "team"),
    fails("LIBRARY_INVALID", /text/),
  );
  assert.throws(
    () => parseInstructionSet({ text: "x", owner: "me" }, "team"),
    fails("LIBRARY_INVALID", /owner/),
  );
  assert.throws(
    () => parseInstructionSet({ text: "x", agents: ["hermes"] }, "team"),
    fails("LIBRARY_UNSUPPORTED", /instructions/),
  );
});

void test("library validation: invalid skill directories are rejected", async (t) => {
  const { root } = await sandbox(t);
  const ok = await writeSkill(path.join(root, "ok"), "pdf-tools", "PDFs.");
  const skill = await readSkill(ok);
  assert.equal(skill.name, "pdf-tools");
  assert.deepEqual(
    skill.files.map((file) => [file.path, file.executable]),
    [
      ["scripts/run.sh", true],
      ["SKILL.md", false],
    ],
  );

  await assert.rejects(
    readSkill("relative/dir"),
    fails("LIBRARY_SKILL_INVALID", /absolute/),
  );
  const missing = path.join(root, "missing", "no-manifest");
  await mkdir(missing, { recursive: true });
  await assert.rejects(
    readSkill(missing),
    fails("LIBRARY_SKILL_INVALID", /SKILL\.md/),
  );

  const wrong = path.join(root, "renamed", "pdf-tools");
  await mkdir(wrong, { recursive: true });
  await writeFile(
    path.join(wrong, "SKILL.md"),
    "---\nname: other-name\ndescription: x\n---\n",
  );
  await assert.rejects(
    readSkill(wrong),
    fails("LIBRARY_SKILL_INVALID", /name of its directory/),
  );

  const upper = path.join(root, "upper", "Pdf");
  await mkdir(upper, { recursive: true });
  await writeFile(
    path.join(upper, "SKILL.md"),
    "---\nname: Pdf\ndescription: x\n---\n",
  );
  await assert.rejects(
    readSkill(upper),
    fails("LIBRARY_SKILL_INVALID", /lowercase/),
  );

  const bare = path.join(root, "bare", "pdf");
  await mkdir(bare, { recursive: true });
  await writeFile(path.join(bare, "SKILL.md"), "# no front matter\n");
  await assert.rejects(
    readSkill(bare),
    fails("LIBRARY_SKILL_INVALID", /front matter/),
  );

  const linked = await writeSkill(
    path.join(root, "linked"),
    "linked",
    "Links.",
  );
  await symlink("/etc/hosts", path.join(linked, "hosts"));
  await assert.rejects(
    readSkill(linked),
    fails("LIBRARY_SKILL_INVALID", /link/),
  );
});
