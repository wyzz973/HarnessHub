import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { withWindowsReadLock } from "../../src/platform/windows-file-lock.js";

void test(
  "Windows read lease rejects existing writers, blocks new writers, and closes on abort",
  { skip: process.platform !== "win32", timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "harnesshub-read-lease-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "中文 文件.txt");
    await writeFile(file, "snapshot");
    const writer = await open(file, "r+");
    try {
      await assert.rejects(
        withWindowsReadLock(file, new AbortController().signal, async () =>
          assert.fail("Existing writer must prevent the read"),
        ),
        { code: "ARTIFACT_CHANGED" },
      );
    } finally {
      await writer.close();
    }
    const bytes = await withWindowsReadLock(
      file,
      new AbortController().signal,
      async () => {
        await assert.rejects(
          open(file, "r+"),
          (error: unknown) =>
            error instanceof Error &&
            "code" in error &&
            ["EBUSY", "EPERM", "EACCES"].includes(String(error.code)),
        );
        return readFile(file, "utf8");
      },
    );
    assert.equal(bytes, "snapshot");
    const abort = new AbortController();
    await assert.rejects(
      withWindowsReadLock(file, abort.signal, async () => {
        abort.abort();
        return "cancelled";
      }),
      { name: "AbortError" },
    );
    await writeFile(file, "after release");
    assert.equal(await readFile(file, "utf8"), "after release");
  },
);
