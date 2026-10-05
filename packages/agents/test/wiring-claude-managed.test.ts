// SPDX-License-Identifier: MIT
/**
 * Claude Code's managed settings, which an administrator's policy puts over
 * the user's settings: wiring reads them to warn, and never writes them.
 * The system paths are relocated under a temporary root.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyWiring,
  managedOverrides,
  wiredEntries,
  wiringAdapter,
} from "../src/wiring/index.js";
import { sandbox, TARGET } from "./wiring-support.js";

/** Where Claude Code reads managed settings on this platform, under `root`. */
function managedFile(root: string): string {
  const [first] = wiringAdapter("claude").managedFiles!(process.platform);
  return path.join(root, first!.replace(/^[A-Za-z]:/, ""));
}

void test("claude: managed settings that set an entry wiring writes are reported, read only", async (t) => {
  const context = await sandbox(t);
  const systemRoot = path.join(context.root, "system");
  const file = managedFile(systemRoot);
  // Nothing there: nothing overrides.
  assert.deepEqual(
    await managedOverrides("claude", [["env", "ANTHROPIC_BASE_URL"]], {
      systemRoot,
    }),
    [],
  );
  const policy = JSON.stringify({
    env: { ANTHROPIC_BASE_URL: "https://proxy.corp.example.test" },
    model: "opus",
    permissions: { deny: ["WebFetch"] },
  });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, policy);

  const { record } = await applyWiring("claude", TARGET, {
    ...context,
    systemRoot,
  });
  const entries = await wiredEntries(record, context);
  assert.ok(
    entries.some((entry) => entry.join(".") === "env.ANTHROPIC_AUTH_TOKEN"),
  );
  const [managed] = wiringAdapter("claude").managedFiles!(process.platform);
  assert.deepEqual(await managedOverrides("claude", entries, { systemRoot }), [
    {
      path: managed,
      keyPaths: [["env", "ANTHROPIC_BASE_URL"], ["model"]],
    },
  ]);
  // Read only: the administrator's file is as it was.
  assert.equal(await readFile(file, "utf8"), policy);

  // A file that does not parse may still apply; it is reported as such.
  await writeFile(file, "{ not json");
  assert.deepEqual(await managedOverrides("claude", entries, { systemRoot }), [
    { path: managed, keyPaths: [] },
  ]);
  // An agent without managed files has none.
  assert.deepEqual(
    await managedOverrides("codex", [["model"]], { systemRoot }),
    [],
  );
});

void test("claude: a managed path that is no regular file is reported as unreadable, never a failure or a wait", async (t) => {
  const context = await sandbox(t);
  const systemRoot = path.join(context.root, "system");
  const file = managedFile(systemRoot);
  const [managed] = wiringAdapter("claude").managedFiles!(process.platform);
  const unreadable = [{ path: managed, keyPaths: [] }];
  const read = () =>
    managedOverrides("claude", [["env", "ANTHROPIC_BASE_URL"]], {
      systemRoot,
    });
  // A directory in its place (another user may make one in a shared path).
  await mkdir(file, { recursive: true });
  assert.deepEqual(await read(), unreadable);
  await rm(file, { recursive: true });
  // Larger than any policy.
  await writeFile(file, " ".repeat(1024 * 1024 + 1));
  assert.deepEqual(await read(), unreadable);
  await rm(file);
  // A link, which it does not follow.
  const target = path.join(context.root, "elsewhere.json");
  await writeFile(target, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "x" } }));
  await symlink(target, file);
  assert.deepEqual(await read(), unreadable);
  await rm(file);
  if (process.platform !== "win32") {
    // A named pipe nothing writes to: answered at once, not waited on.
    execFileSync("mkfifo", [file]);
    const started = Date.now();
    assert.deepEqual(await read(), unreadable);
    assert.ok(Date.now() - started < 2_000);
  }
});

void test("claude and codex say what to do after a change: restart them", () => {
  for (const id of ["claude", "codex"])
    assert.match(wiringAdapter(id).restartNotice ?? "", /restart/i, id);
  const platforms = ["darwin", "linux", "win32"] as const;
  assert.deepEqual(
    platforms.map((platform) =>
      wiringAdapter("claude").managedFiles!(platform),
    ),
    [
      ["/Library/Application Support/ClaudeCode/managed-settings.json"],
      ["/etc/claude-code/managed-settings.json"],
      [
        "C:\\Program Files\\ClaudeCode\\managed-settings.json",
        "C:\\ProgramData\\ClaudeCode\\managed-settings.json",
      ],
    ],
  );
});
