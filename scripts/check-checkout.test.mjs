import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

void test("Windows autocrlf checkout keeps source LF and source ZIP bytes; absent attributes reproduces CRLF", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "hh-checkout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const attributes = await readFile(
    new URL("../.gitattributes", import.meta.url),
  );
  const binary = Buffer.from([0x50, 0x4b, 3, 4, 13, 10, 0, 10, 255]);
  for (const enabled of [false, true]) {
    const cwd = path.join(directory, String(enabled));
    const output = path.join(directory, `checkout-${enabled}`);
    await mkdir(cwd);
    await mkdir(output);
    const git = (args) =>
      execFileSync(
        "git",
        ["-c", "core.autocrlf=true", "-c", "core.safecrlf=false", ...args],
        { cwd, windowsHide: true, stdio: "pipe" },
      );
    git(["init", "--quiet"]);
    await writeFile(path.join(cwd, "source.ts"), "first\nsecond\n");
    await writeFile(path.join(cwd, "source.zip.part001"), binary);
    if (enabled) await writeFile(path.join(cwd, ".gitattributes"), attributes);
    git(["add", "."]);
    git([
      "checkout-index",
      "--all",
      `--prefix=${output.replaceAll("\\", "/")}/`,
    ]);
    assert.equal(
      await readFile(path.join(output, "source.ts"), "utf8"),
      enabled ? "first\nsecond\n" : "first\r\nsecond\r\n",
    );
    assert.deepEqual(
      await readFile(path.join(output, "source.zip.part001")),
      binary,
    );
  }
});
