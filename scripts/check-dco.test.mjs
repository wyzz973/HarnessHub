// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkSignoffs, readCommits } from "./check-dco.mjs";

function git(cwd, args, author = ["Ada", "ada@example.com"]) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_AUTHOR_NAME: author[0],
      GIT_AUTHOR_EMAIL: author[1],
      GIT_COMMITTER_NAME: author[0],
      GIT_COMMITTER_EMAIL: author[1],
    },
  }).trim();
}

test("accepts signed-off commits and bot commits, rejects the rest from a real range", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "hh-dco-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["commit", "-q", "--allow-empty", "-m", "base"]);
  const base = git(cwd, ["rev-parse", "HEAD"]);
  git(cwd, ["commit", "-q", "--allow-empty", "-s", "-m", "feat: signed"]);
  git(cwd, ["commit", "-q", "--allow-empty", "-m", "fix: unsigned"]);
  git(cwd, ["commit", "-q", "--allow-empty", "-m", "fix: other person\n\nSigned-off-by: Bob <bob@example.com>"]);
  git(cwd, ["commit", "-q", "--allow-empty", "-m", "fix: case\n\nSigned-off-by: Ada <ADA@Example.com>"]);
  git(cwd, ["commit", "-q", "--allow-empty", "-m", "fix: in body\n\nSigned-off-by: Ada <ada@example.com>\n\nA later paragraph, so the line is not a trailer."]);
  git(cwd, ["commit", "-q", "--allow-empty", "-m", "chore(deps): bump"], ["dependabot[bot]", "1+dependabot[bot]@users.noreply.github.com"]);

  const commits = readCommits(`${base}..HEAD`, cwd);
  assert.equal(commits.length, 6);
  const subjects = new Map(commits.map((commit) => [commit.sha, git(cwd, ["log", "-1", "--format=%s", commit.sha])]));
  const rejected = checkSignoffs(commits).map((line) => subjects.get(line.slice(0, 40)));
  assert.deepEqual(rejected.sort(), ["fix: in body", "fix: other person", "fix: unsigned"]);
});

test("git failures are not reported as a passing range", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "hh-dco-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["commit", "-q", "--allow-empty", "-m", "base"]);
  assert.throws(() => readCommits("does-not-exist..HEAD", cwd), /does-not-exist/);
});
