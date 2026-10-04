// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { consoleEnvironment, findLeaks } from "./console.mjs";

test("the console toolchain sees system variables and its own settings only", () => {
  const { env, needles } = consoleEnvironment({
    PATH: "/bin",
    HOME: "/Users/dev",
    CI: "true",
    HARNESSHUB_DAEMON_URL: "http://127.0.0.1:3180",
    HARNESSHUB_DATA_DIR: "/Users/dev/HarnessHub/data/local",
    GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_developer_token_value",
    HARNESSHUB_MODEL_API_KEY: "sk-developer-key",
    AWS_SESSION_TOKEN: "short",
    HARNESSHUB_CONSOLE_CANARY: "0123456789abcdef",
    NODE_OPTIONS: "--require hook.js",
    PWD: "/Users/dev/HarnessHub",
  });
  // The daemon's data directory (where admin.token is) is not passed: the
  // console never reads the token.
  assert.deepEqual(env, {
    PATH: "/bin",
    HOME: "/Users/dev",
    CI: "true",
    HARNESSHUB_DAEMON_URL: "http://127.0.0.1:3180",
  });
  // Credential-looking and canary values are scanned for; paths and short values are not.
  assert.deepEqual(Object.keys(needles).sort(), [
    "GITHUB_PERSONAL_ACCESS_TOKEN",
    "HARNESSHUB_CONSOLE_CANARY",
    "HARNESSHUB_MODEL_API_KEY",
  ]);
});

test("finds a leaked value inside binary cache files and names only the variable", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-console-leak-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "assets"), { recursive: true });
  await writeFile(
    path.join(directory, "assets", "index-0a1b2c.js"),
    Buffer.concat([Buffer.from([0, 255, 17]), Buffer.from("GITHUB_PERSONAL_ACCESS_TOKEN(ghp_developer_token_value"), Buffer.from([0])]),
  );
  await writeFile(path.join(directory, "clean.js"), "export {};\n");
  const needles = { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_developer_token_value", OTHER_TOKEN: "absent-value" };
  assert.deepEqual(await findLeaks(directory, needles), [
    `GITHUB_PERSONAL_ACCESS_TOKEN in ${path.join("assets", "index-0a1b2c.js")}`,
  ]);

  const clean = await mkdtemp(path.join(os.tmpdir(), "hh-console-clean-"));
  t.after(() => rm(clean, { recursive: true, force: true }));
  await writeFile(path.join(clean, "page.js"), "export {};\n");
  assert.deepEqual(await findLeaks(clean, needles), []);
});
