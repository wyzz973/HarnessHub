// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectBuildInfo } from "./build-info.mjs";

async function project(t, { repository }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hh-build-info-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "checkout");
  await mkdir(cwd);
  await writeFile(path.join(root, "gitconfig"), "");
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ version: "9.8.7" }));
  const git = (...args) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
        GIT_CEILING_DIRECTORIES: root,
        GIT_AUTHOR_NAME: "Ada",
        GIT_AUTHOR_EMAIL: "ada@example.com",
        GIT_COMMITTER_NAME: "Ada",
        GIT_COMMITTER_EMAIL: "ada@example.com",
        GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
      },
    }).trim();
  if (repository) {
    git("init", "-q", "-b", "main");
    git("add", "package.json");
    git("commit", "-q", "-m", "base");
  }
  return { cwd, git, root };
}

const fixed = new Date("2026-10-02T00:00:00Z");

test("a local build records the checkout's commit, ref, date and dirty state", async (t) => {
  const { cwd, git } = await project(t, { repository: true });
  const info = await collectBuildInfo({ cwd, env: {}, now: fixed });
  assert.deepEqual(
    { ...info, os: undefined, arch: undefined, nodeVersion: undefined },
    {
      version: "9.8.7",
      channel: "dev",
      commit: git("rev-parse", "HEAD"),
      commitDate: "2026-01-02T03:04:05Z",
      ref: "refs/heads/main",
      dirty: false,
      builtAt: fixed.toISOString(),
      workflowRun: null,
      os: undefined,
      arch: undefined,
      nodeVersion: undefined,
      installMethod: "source",
    },
  );
  assert.equal(info.nodeVersion, process.version);
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ version: "9.8.8" }));
  assert.equal((await collectBuildInfo({ cwd, env: {}, now: fixed })).dirty, true);
});

test("CI identity comes from the workflow, and SOURCE_DATE_EPOCH fixes builtAt", async (t) => {
  const { cwd } = await project(t, { repository: true });
  const info = await collectBuildInfo({
    cwd,
    now: fixed,
    env: {
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      GITHUB_REF: "refs/pull/8/merge",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "wyzz973/HarnessHub",
      GITHUB_RUN_ID: "42",
      SOURCE_DATE_EPOCH: "1767323045",
    },
  });
  assert.equal(info.commit, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(info.ref, "refs/pull/8/merge");
  assert.equal(info.workflowRun, "https://github.com/wyzz973/HarnessHub/actions/runs/42");
  assert.equal(info.builtAt, "2026-01-02T03:04:05.000Z");
  // The CI commit is not in this checkout: its date is unknown, not guessed.
  assert.equal(info.commitDate, "unknown");
  await assert.rejects(collectBuildInfo({ cwd, env: { SOURCE_DATE_EPOCH: "yesterday" } }), /whole seconds/);
});

test("without git every repository field is unknown, not guessed", async (t) => {
  const { cwd } = await project(t, { repository: false });
  const info = await collectBuildInfo({ cwd, env: {}, now: fixed });
  assert.equal(info.commit, "unknown");
  assert.equal(info.commitDate, "unknown");
  assert.equal(info.ref, "unknown");
  assert.equal(info.dirty, "unknown");
});
