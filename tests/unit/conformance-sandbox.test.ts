// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findAgent,
  sandboxUnavailable,
  seatbelt,
} from "../conformance/support.js";

/** A listening loopback port, closed after the test. */
async function listening(t: test.TestContext): Promise<number> {
  const server = createServer((socket) => {
    // The probe exits as soon as it is connected; its reset says nothing.
    socket.on("error", () => undefined);
    socket.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as { port: number }).port;
}

void test("the conformance sandbox lets an agent reach only the gateway's port and write only inside its directory", async (t) => {
  const unavailable = await sandboxUnavailable();
  if (unavailable) return t.skip(unavailable);
  const parent = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "hh-seatbelt-")),
  );
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "root");
  await mkdir(root);
  const allowed = await listening(t);
  const other = await listening(t);
  const profile = path.join(root, "profile.sb");
  await writeFile(profile, seatbelt(root, allowed));
  const probe = (script: string) =>
    spawnSync(
      "/usr/bin/sandbox-exec",
      ["-f", profile, process.execPath, "-e", script],
      { encoding: "utf8", timeout: 20_000 },
    );
  const connect = (port: number) =>
    probe(
      `require("node:net").connect(${port}, "127.0.0.1").on("connect", () => process.exit(0)).on("error", (e) => { console.error(e.code); process.exit(3); })`,
    );
  assert.equal(connect(allowed).status, 0, "the gateway's port is reachable");
  const refused = connect(other);
  assert.equal(refused.status, 3, "another loopback port is not");
  assert.match(refused.stderr, /EPERM|EACCES/);
  const write = (file: string) =>
    probe(
      `try { require("node:fs").writeFileSync(${JSON.stringify(file)}, "x"); } catch (e) { console.error(e.code); process.exit(3); }`,
    );
  assert.equal(write(path.join(root, "inside.txt")).status, 0);
  const outside = write(path.join(parent, "outside.txt"));
  assert.equal(outside.status, 3, "nothing is written outside the sandbox");
  assert.match(outside.stderr, /EPERM|EACCES/);
});

void test("the conformance suite finds an agent outside wrapper directories", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "hh-find-agent-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const shim = path.join(parent, "cmux-cli-shims", "ABC");
  const real = path.join(parent, "bin");
  for (const directory of [shim, real]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "fake-agent"), "#!/bin/sh\n");
    await chmod(path.join(directory, "fake-agent"), 0o755);
  }
  assert.deepEqual(
    await findAgent("fake-agent", [], [shim, real].join(path.delimiter)),
    { directory: real, file: path.join(real, "fake-agent") },
  );
  assert.equal(await findAgent("fake-agent", [], shim), undefined);
  assert.deepEqual(await findAgent("fake-agent", [real], shim), {
    directory: real,
    file: path.join(real, "fake-agent"),
  });
});
