import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareEngine } from "../../src/engine/registry.js";
import {
  bindInstalled,
  importLocal,
  listInstalled,
  SESSION_WORKSPACE_PLACEHOLDER,
} from "../../src/tool-packages/index.js";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123";

async function temporary(t: test.TestContext): Promise<string> {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "hh-tool-import-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function tree(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, ...name.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}
/** Every byte stored below `root`, to prove secrets never reach the store. */
async function storedBytes(root: string): Promise<string> {
  let text = "";
  for (const entry of await readdir(root, {
    withFileTypes: true,
    recursive: true,
  }))
    if (entry.isFile())
      text += await readFile(path.join(entry.parentPath, entry.name), "latin1");
  return text;
}

void test("Claude Desktop mcp.json imports a node server with workspace variables, package paths and secret env references", async (t) => {
  const directory = await temporary(t);
  const source = path.join(directory, "My Tools");
  await tree(source, {
    "mcp.json": JSON.stringify({
      mcpServers: {
        files: {
          command: "node",
          args: [
            "./server/index.mjs",
            "--root",
            "${workspaceFolder}",
            "--out=${workspaceFolder}/out",
            "--config",
            "./server/config.json",
            "--level",
            3,
          ],
          env: {
            MODE: "fast",
            GITHUB_TOKEN: SECRET,
            DATA_DIR: "${workspaceFolder}/data",
            FROM_ENV: "${env:SOME_VALUE}",
          },
          autoApprove: ["read"],
        },
      },
    }),
    "server/index.mjs": "export {};\n",
    "server/config.json": '{"ok":true}\n',
    "server/node_modules/dep/index.js": "module.exports = 1;\n",
    ".env": `GITHUB_TOKEN=${SECRET}\n`,
    ".git/config": "[core]\n",
    ".DS_Store": "junk",
  });
  const store = path.join(directory, "store");
  const imported = await importLocal(source, store);
  assert.equal(imported.format, "generated");
  assert.deepEqual(imported.counts, { skills: 0, mcp: 1, cli: 0 });
  const manifest = imported.installed.manifest;
  assert.equal(manifest.id, "my-tools");
  assert.equal(manifest.displayName, "My Tools");
  assert.match(manifest.version, /^auto-[a-f0-9]{12}$/);
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    [
      "server/config.json",
      "server/index.mjs",
      "server/node_modules/dep/index.js",
    ],
    "config, .env, VCS and OS metadata are never copied; node_modules of local servers are",
  );
  assert.deepEqual(manifest.mcpServers, [
    {
      name: "files",
      launch: "node",
      entry: "server/index.mjs",
      args: [
        "--root",
        { anchor: "workspace" },
        `--out=${SESSION_WORKSPACE_PLACEHOLDER}/out`,
        "--config",
        { anchor: "package", path: "server/config.json" },
        "--level",
        "3",
      ],
      env: { MODE: "fast", DATA_DIR: `${SESSION_WORKSPACE_PLACEHOLDER}/data` },
      secretEnv: { GITHUB_TOKEN: "GITHUB_TOKEN", FROM_ENV: "FROM_ENV" },
    },
  ]);
  assert.deepEqual(manifest.defaultSecretBindings, {
    GITHUB_TOKEN: { kind: "env", value: "GITHUB_TOKEN" },
    FROM_ENV: { kind: "env", value: "SOME_VALUE" },
  });
  const warnings = imported.warnings.join("\n");
  assert.match(warnings, /GITHUB_TOKEN looks like a secret/);
  assert.match(warnings, /unset, Sessions .* fail with SECRET_UNAVAILABLE/);
  assert.match(
    warnings,
    /FROM_ENV is read from environment variable SOME_VALUE/,
  );
  assert.match(warnings, /Skipped environment files .*\.env/);
  assert.match(warnings, /ignored fields autoApprove/);
  assert.equal(
    (await storedBytes(store)).includes(SECRET),
    false,
    "secret values from mcp.json or .env never reach the store",
  );

  const again = await importLocal(source, store);
  assert.equal(again.installed.digest, imported.installed.digest);
  assert.equal(again.installed.manifest.version, manifest.version);
  await writeFile(
    path.join(source, "server/index.mjs"),
    "export const v = 2;\n",
  );
  const changed = await importLocal(source, store);
  assert.notEqual(changed.installed.manifest.version, manifest.version);
  assert.equal((await listInstalled(store)).length, 2);

  const fragment = await bindInstalled(store, "my-tools", manifest.version, {
    nodeExecutable: process.execPath,
    workspace: "/ignored/legacy/workspace",
  });
  const server = fragment.mcpServers[0]!;
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args!.slice(1, 4), [
    "--root",
    SESSION_WORKSPACE_PLACEHOLDER,
    `--out=${SESSION_WORKSPACE_PLACEHOLDER}/out`,
  ]);
  assert.ok(server.args![5]!.endsWith(path.join("server", "config.json")));
  assert.equal(JSON.stringify(fragment).includes("/ignored/legacy"), false);
  assert.deepEqual(server.secretEnv, {
    GITHUB_TOKEN: { kind: "env", value: "GITHUB_TOKEN" },
    FROM_ENV: { kind: "env", value: "SOME_VALUE" },
  });
  const overridden = await bindInstalled(store, "my-tools", manifest.version, {
    nodeExecutable: process.execPath,
    secretBindings: {
      GITHUB_TOKEN: { kind: "file", value: path.join(directory, "token") },
    },
  });
  assert.deepEqual(overridden.mcpServers[0]!.secretEnv!.GITHUB_TOKEN, {
    kind: "file",
    value: path.join(directory, "token"),
  });
});

void test("VS Code servers with HTTP/SSE transports import without files and keep header credentials as references", async (t) => {
  const directory = await temporary(t);
  const source = path.join(directory, "remote");
  await tree(source, {
    ".vscode/mcp.json": JSON.stringify({
      inputs: [{ id: "api-key", type: "promptString", password: true }],
      servers: {
        "remote api": {
          type: "http",
          url: "http://127.0.0.1:8123/mcp",
          headers: {
            Authorization: "Bearer ${input:api-key}",
            "X-Tenant": "team-a",
            "X-Api-Key": "${input:api-key}",
          },
        },
        events: { type: "sse", url: "http://127.0.0.1:8124/sse" },
      },
    }),
  });
  const store = path.join(directory, "store");
  const imported = await importLocal(source, store, { kind: "mcp" });
  const manifest = imported.installed.manifest;
  assert.deepEqual(manifest.files, []);
  assert.deepEqual(manifest.mcpServers, [
    {
      name: "remote-api",
      type: "http",
      url: "http://127.0.0.1:8123/mcp",
      headers: { "X-Tenant": "team-a" },
      secretHeaders: { Authorization: "AUTHORIZATION", "X-Api-Key": "API_KEY" },
    },
    { name: "events", type: "sse", url: "http://127.0.0.1:8124/sse" },
  ]);
  assert.deepEqual(manifest.defaultSecretBindings, {
    AUTHORIZATION: { kind: "env", value: "AUTHORIZATION" },
    API_KEY: { kind: "env", value: "API_KEY" },
  });
  assert.match(
    imported.warnings.join("\n"),
    /remote api: imported as remote-api/,
  );
  const fragment = await bindInstalled(store, manifest.id, manifest.version, {
    nodeExecutable: process.execPath,
  });
  assert.deepEqual(fragment.mcpServers[0], {
    name: "remote-remote-api",
    type: "http",
    enabled: true,
    url: "http://127.0.0.1:8123/mcp",
    headers: { "X-Tenant": "team-a" },
    secretHeaders: {
      Authorization: { kind: "env", value: "AUTHORIZATION" },
      "X-Api-Key": { kind: "env", value: "API_KEY" },
    },
  });
  const profile = await prepareEngine({
    id: "remote-engine",
    driver: "acp",
    command: [process.execPath, "never-run.js"],
    configuration: { adapter: "generic", ...fragment },
  });
  assert.equal(profile.configuration!.mcpServers!.length, 2);
});

void test("runtime downloaders, PATH commands, outside files and unsupported fields are rejected together with their reasons", async (t) => {
  const directory = await temporary(t);
  const source = path.join(directory, "bad");
  await tree(source, {
    "outside-marker.txt": "x",
    "mcp.json": JSON.stringify({
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
        },
        fetch: { command: "uvx", args: ["mcp-server-fetch"] },
        pipx: { command: "pipx", args: ["run", "some-server"] },
        bun: { command: "bunx", args: ["some-server"] },
        npmexec: { command: "npm", args: ["exec", "some-server"] },
        python: { command: "python", args: ["server.py"] },
        escape: { command: "node", args: ["../elsewhere.mjs"] },
        cwd: { command: "node", args: ["x.mjs"], cwd: "/tmp" },
        home: { command: "./tool.sh", args: ["${userHome}"] },
      },
    }),
  });
  await writeFile(path.join(directory, "elsewhere.mjs"), "export {};\n");
  const store = path.join(directory, "store");
  await assert.rejects(importLocal(source, store), (error: Error) => {
    assert.equal(
      (error as Error & { code: string }).code,
      "TOOL_PACKAGE_IMPORT_UNSUPPORTED",
    );
    for (const expected of [
      /server filesystem: npx downloads packages when the server starts, which cannot work offline/,
      /server fetch: uvx downloads packages/,
      /server pipx: pipx downloads packages/,
      /server bun: bunx downloads packages/,
      /server npmexec: npm downloads packages/,
      /server python: python would be looked up on PATH/,
      /server escape: \.\.\/elsewhere\.mjs is outside the import directory/,
      /server cwd: cwd is not supported/,
      /server home: \.\/tool\.sh is not a regular file/,
    ])
      assert.match(error.message, expected);
    return true;
  });
  assert.deepEqual(await listInstalled(store), []);
  await writeFile(
    path.join(source, "mcp.json"),
    JSON.stringify({ mcpServers: { only: { command: "npx", args: ["x"] } } }),
  );
  await assert.rejects(importLocal(source, store), {
    code: "TOOL_PACKAGE_IMPORT_UNSUPPORTED",
    message:
      "mcp.json server only: npx downloads packages when the server starts, which cannot work offline. Install the server into the import directory (for example node_modules) and start it with node and a relative script path, or package an executable",
  });
});

void test("Skill discovery and cli.json package Skill resources, CLI entries and executable flags", async (t) => {
  const directory = await temporary(t);
  const source = path.join(directory, "toolkit");
  await tree(source, {
    "skills/a/SKILL.md": "---\nname: a\ndescription: A\n---\nUse ref.md.\n",
    "skills/a/ref.md": "reference\n",
    "skills/b/nested/SKILL.md": "---\nname: b\ndescription: B\n---\nB\n",
    "skills/b/nested/node_modules/x/SKILL.md": "ignored\n",
    "node_modules/pkg/SKILL.md": "ignored\n",
    ".git/SKILL.md": "ignored\n",
    "bin/echo.mjs": "console.log(process.argv.slice(2));\n",
    "bin/tool.sh": "#!/bin/sh\necho tool\n",
    "cli.json": JSON.stringify({
      cliTools: [
        { name: "echo", entry: "bin/echo.mjs" },
        {
          name: "native",
          description: "Native tool",
          entry: "./bin/tool.sh",
          args: ["${workspaceFolder}", "--flag"],
        },
      ],
    }),
  });
  await chmod(path.join(source, "bin/tool.sh"), 0o644);
  await symlink(
    path.join(source, "skills/a"),
    path.join(source, "skills/link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const store = path.join(directory, "store");
  const imported = await importLocal(source, store);
  const manifest = imported.installed.manifest;
  assert.deepEqual(imported.counts, { skills: 2, mcp: 0, cli: 2 });
  assert.deepEqual(manifest.skills, [
    { path: "skills/a/SKILL.md" },
    { path: "skills/b/nested/SKILL.md" },
  ]);
  assert.deepEqual(manifest.cliTools, [
    { name: "echo", launch: "node", entry: "bin/echo.mjs" },
    {
      name: "native",
      description: "Native tool",
      launch: "native",
      entry: "bin/tool.sh",
      args: [{ anchor: "workspace" }, "--flag"],
    },
  ]);
  assert.equal(
    manifest.files.find((file) => file.path === "bin/tool.sh")!.executable,
    true,
    "native entries are marked executable even without a source exec bit",
  );
  assert.match(
    imported.warnings.join("\n"),
    /Skipped 1 symbolic links or junctions: skills\/link/,
  );
  if (process.platform !== "win32")
    assert.ok(
      (
        await lstat(
          path.join(store, "objects", imported.installed.digest, "bin/tool.sh"),
        )
      ).mode & 0o100,
    );

  const skillsOnly = await importLocal(source, store, {
    kind: "skills",
    id: "toolkit-skills",
  });
  assert.deepEqual(
    skillsOnly.installed.manifest.files.map((file) => file.path),
    ["skills/a/SKILL.md", "skills/a/ref.md", "skills/b/nested/SKILL.md"],
    "Skill-only packages copy Skill directories without node_modules or other files",
  );

  await writeFile(
    path.join(source, "cli.json"),
    JSON.stringify({
      cliTools: [
        {
          name: "echo",
          entry: "bin/echo.mjs",
          args: ["--root=${workspaceFolder}"],
        },
      ],
    }),
  );
  await assert.rejects(importLocal(source, store, { kind: "cli" }), {
    code: "TOOL_PACKAGE_IMPORT_UNSUPPORTED",
    message: /\$\{workspaceFolder\} only as a whole argument/,
  });
});

void test("tool-package.json directories install unchanged while JSON and SKILL.md files import on their own", async (t) => {
  const directory = await temporary(t);
  const store = path.join(directory, "store");
  const portable = fileURLToPath(
    new URL("../../../examples/tool-packages/portable-review", import.meta.url),
  );
  const native = await importLocal(portable, store);
  assert.equal(native.format, "tool-package");
  assert.equal(native.installed.manifest.id, "portable-review");
  const manifestFile = await importLocal(
    path.join(portable, "tool-package.json"),
    store,
  );
  assert.equal(manifestFile.format, "tool-package");
  assert.equal(manifestFile.installed.digest, native.installed.digest);
  await assert.rejects(importLocal(portable, store, { id: "other" }), {
    code: "INVALID_TOOL_PACKAGE_SOURCE",
  });

  const source = path.join(directory, "configs");
  await tree(source, {
    "github-mcp.json": `﻿${JSON.stringify({
      mcpServers: { local: { command: "./server.mjs" } },
    })}`,
    "server.mjs": "export {};\n",
    "skill/SKILL.md": "---\nname: s\ndescription: S\n---\nS\n",
    "skill/notes.md": "notes\n",
    "commented.json": '{\n  // comment\n  "mcpServers": {}\n}\n',
    "cli-only.json": JSON.stringify({ cliTools: [] }),
  });
  const file = await importLocal(path.join(source, "github-mcp.json"), store);
  assert.equal(file.installed.manifest.id, "github-mcp");
  assert.deepEqual(file.installed.manifest.mcpServers, [
    { name: "local", launch: "node", entry: "server.mjs" },
  ]);
  assert.equal(
    file.installed.manifest.files.some(
      (entry) => entry.path === "github-mcp.json",
    ),
    false,
  );
  const skill = await importLocal(path.join(source, "skill/SKILL.md"), store);
  assert.equal(skill.installed.manifest.id, "skill");
  assert.deepEqual(skill.installed.manifest.skills, [{ path: "SKILL.md" }]);
  assert.deepEqual(
    skill.installed.manifest.files.map((entry) => entry.path),
    ["SKILL.md", "notes.md"],
  );
  for (const [input, options, code, message] of [
    ["relative/path", {}, "INVALID_TOOL_PACKAGE_SOURCE", /absolute/],
    [
      path.join(source, "missing"),
      {},
      "INVALID_TOOL_PACKAGE_SOURCE",
      /does not exist/,
    ],
    [
      path.join(source, "commented.json"),
      {},
      "INVALID_TOOL_PACKAGE_SOURCE",
      /strict UTF-8 JSON/,
    ],
    [
      path.join(source, "github-mcp.json"),
      { kind: "cli" },
      "INVALID_TOOL_PACKAGE_SOURCE",
      /does not contain cliTools/,
    ],
    [
      path.join(source, "github-mcp.json"),
      { kind: "skills" },
      "INVALID_TOOL_PACKAGE_SOURCE",
      /skills source/,
    ],
    [
      path.join(source, "cli-only.json"),
      { id: "Bad Id" },
      "INVALID_TOOL_PACKAGE_SOURCE",
      /id must start/,
    ],
    [directory, { kind: "cli" }, "INVALID_TOOL_PACKAGE_SOURCE", /No cli\.json/],
  ] as const)
    await assert.rejects(
      importLocal(input, store, options),
      { code, message },
      `${input} ${JSON.stringify(options)}`,
    );
  const empty = path.join(directory, "empty");
  await mkdir(empty);
  await assert.rejects(importLocal(empty, store), {
    code: "INVALID_TOOL_PACKAGE_SOURCE",
    message: /No tool-package\.json, SKILL\.md/,
  });
});
