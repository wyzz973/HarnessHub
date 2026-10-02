import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
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
import { promisify } from "node:util";
import { bindInstalled, installLocal } from "../../src/tool-packages/index.js";

const source = fileURLToPath(
  new URL("../../../examples/tool-packages/workspace-tools", import.meta.url),
);
const execute = promisify(execFile);
type Response = {
  jsonrpc: string;
  id: number | null;
  result?: {
    content?: { type: string; text: string }[];
    isError?: boolean;
    tools?: { name: string; annotations: { readOnlyHint: boolean } }[];
    protocolVersion?: string;
  };
  error?: { code: number; message: string };
};
function client(entry: string, root: string) {
  const child = spawn(process.execPath, [entry, "--root", root], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<
    number,
    {
      resolve: (value: Response) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let sequence = 0;
  let buffered = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    stderr += text;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    buffered += text;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const response = JSON.parse(buffered.slice(0, newline)) as Response;
      buffered = buffered.slice(newline + 1);
      if (response.id === null) continue;
      const waiter = pending.get(response.id);
      if (waiter) {
        pending.delete(response.id);
        clearTimeout(waiter.timer);
        waiter.resolve(response);
      }
    }
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      for (const waiter of pending.values()) waiter.reject(error);
    });
    child.once("close", (code) => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`Server exited early: ${stderr}`));
      }
      pending.clear();
      resolve(code);
    });
  });
  return {
    child,
    closed,
    notify(method: string) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
    },
    request(method: string, params?: unknown): Promise<Response> {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out: ${method}`));
          child.kill();
        }, 8000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            ...(params === undefined ? {} : { params }),
          }) + "\n",
        );
      });
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 3000);
      try {
        assert.equal(await closed, 0, stderr);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
async function initialize(
  peer: ReturnType<typeof client>,
  version = "2025-11-25",
) {
  const reply = await peer.request("initialize", {
    protocolVersion: version,
    capabilities: {},
    clientInfo: { name: "harnesshub-test", version: "1" },
  });
  peer.notify("notifications/initialized");
  return reply;
}
function content(response: Response): Record<string, unknown> {
  assert.equal(response.error, undefined);
  assert.equal(response.result?.isError, false, JSON.stringify(response));
  assert.equal(response.result.content![0]!.type, "text");
  return JSON.parse(response.result.content![0]!.text) as Record<
    string,
    unknown
  >;
}

void test(
  "installed workspace tools serve real MCP initialize/list/read/search and release every file/stdio resource on EOF",
  { timeout: 20000 },
  async (t) => {
    const directory = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "hh-workspace-mcp-")),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const root = path.join(directory, "workspace 中文");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src/example.txt"),
      "alpha\nneedle 中文\nthird\n",
    );
    await mkdir(path.join(root, "node_modules"));
    await writeFile(
      path.join(root, "node_modules/skipped.txt"),
      "needle hidden",
    );
    const installed = await installLocal(source, path.join(directory, "store"));
    const bound = await bindInstalled(
      path.join(directory, "store"),
      installed.manifest.id,
      installed.manifest.version,
      { nodeExecutable: process.execPath, workspace: root },
    );
    assert.equal(bound.mcpServers[0]!.command, process.execPath);
    const peer = client(bound.mcpServers[0]!.args![0]!, root);
    try {
      const premature = await peer.request("tools/list");
      assert.equal(premature.error!.code, -32000);
      assert.equal(
        (await initialize(peer)).result!.protocolVersion,
        "2025-11-25",
      );
      const tools = (await peer.request("tools/list")).result!.tools!;
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["workspace_list", "workspace_read", "workspace_search"],
      );
      assert.ok(tools.every((tool) => tool.annotations.readOnlyHint));
      const listed = content(
        await peer.request("tools/call", {
          name: "workspace_list",
          arguments: { path: "." },
        }),
      );
      assert.equal(listed.truncated, false);
      const read = content(
        await peer.request("tools/call", {
          name: "workspace_read",
          arguments: { path: "src/example.txt", startLine: 2, maxLines: 1 },
        }),
      );
      assert.equal(read.text, "needle 中文");
      assert.equal(read.startLine, 2);
      assert.equal(read.truncated, true);
      const search = content(
        await peer.request("tools/call", {
          name: "workspace_search",
          arguments: { path: ".", query: "needle" },
        }),
      );
      assert.deepEqual(search.matches, [
        { path: "src/example.txt", line: 2, text: "needle 中文" },
      ]);
      assert.equal(search.skipped, 1);
      assert.equal((await peer.request("unknown-method")).error!.code, -32601);
      assert.equal(
        (
          await peer.request("tools/call", {
            name: "unknown-tool",
            arguments: {},
          })
        ).error!.code,
        -32602,
      );
      assert.deepEqual((await peer.request("ping")).result, {});
    } finally {
      await peer.close();
    }
    await writeFile(
      path.join(root, "src/example.txt"),
      "writable after server exit",
    );
    assert.equal(
      await readFile(path.join(root, "src/example.txt"), "utf8"),
      "writable after server exit",
    );
  },
);

void test(
  "workspace tools reject escapes, links, binaries, large files and excess arguments, and explicitly truncate large directories",
  { timeout: 20000 },
  async (t) => {
    const directory = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "hh-workspace-limits-")),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const root = path.join(directory, "workspace");
    await mkdir(root);
    const external = path.join(directory, "external");
    await mkdir(external);
    await writeFile(
      path.join(external, "outside.txt"),
      "outside private bytes",
    );
    await symlink(
      external,
      path.join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await link(
      path.join(external, "outside.txt"),
      path.join(root, "hardlink.txt"),
    );
    await writeFile(path.join(root, "large.txt"), Buffer.alloc(1048577, 120));
    await writeFile(path.join(root, "binary.txt"), Buffer.from([0, 120]));
    await writeFile(path.join(root, "invalid.txt"), Buffer.from([255, 254]));
    await mkdir(path.join(root, "many"));
    await Promise.all(
      Array.from({ length: 501 }, (_, index) =>
        writeFile(path.join(root, "many", `${index}.txt`), "x"),
      ),
    );
    const peer = client(path.join(source, "workspace-tools.mjs"), root);
    try {
      assert.equal(
        (await initialize(peer, "future-version")).result!.protocolVersion,
        "2025-11-25",
      );
      for (const name of [
        "../external/outside.txt",
        path.join(external, "outside.txt"),
        "C:relative",
        "linked/outside.txt",
        "hardlink.txt",
        "large.txt",
        "binary.txt",
        "invalid.txt",
      ]) {
        const result = await peer.request("tools/call", {
          name: "workspace_read",
          arguments: { path: name },
        });
        assert.equal(result.result!.isError, true, name);
        assert.equal(
          JSON.stringify(result).includes("outside private bytes"),
          false,
        );
      }
      for (const argumentsValue of [
        { path: ".", maxLines: 201 },
        { path: ".", surprising: true },
        { path: ".", startLine: 0 },
      ])
        assert.equal(
          (
            await peer.request("tools/call", {
              name: "workspace_read",
              arguments: argumentsValue,
            })
          ).result!.isError,
          true,
        );
      const listed = content(
        await peer.request("tools/call", {
          name: "workspace_list",
          arguments: { path: "many" },
        }),
      );
      assert.equal((listed.entries as unknown[]).length, 500);
      assert.equal(listed.truncated, true);
    } finally {
      await peer.close();
    }
    const oversized = client(path.join(source, "workspace-tools.mjs"), root);
    oversized.child.stdin.end("x".repeat(65537));
    assert.equal(await oversized.closed, 1);
  },
);

void test("workspace tools standalone CLI returns JSON and rejects invalid requests without starting MCP or a model", async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "hh-workspace-cli-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "notes.txt"), "first\nneedle\n");
  const entry = path.join(source, "workspace-tools.mjs");
  const result = await execute(
    process.execPath,
    [
      entry,
      "--root",
      root,
      "search",
      JSON.stringify({ path: ".", query: "needle" }),
    ],
    { windowsHide: true, timeout: 8000 },
  );
  assert.equal(result.stderr, "");
  assert.deepEqual(
    (JSON.parse(result.stdout) as { matches: unknown[] }).matches,
    [{ path: "notes.txt", line: 2, text: "needle" }],
  );
  await assert.rejects(
    execute(
      process.execPath,
      [entry, "--root", root, "read", JSON.stringify({ path: "../escape" })],
      { windowsHide: true, timeout: 8000 },
    ),
    { code: 1 },
  );
  await assert.rejects(
    execute(process.execPath, [entry, "--root", "relative"], {
      windowsHide: true,
      timeout: 8000,
    }),
    { code: 1 },
  );
});
