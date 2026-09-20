/**
 * The shipped office Tool Pack must stay installable on a real judge machine:
 * its generated bundle must match the recorded hash, its tools must produce
 * readable Office files, and its managed command MCP configuration must fit the
 * engine configuration limit even under a long installation path.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));
const pack = path.join(repo, "packs", "office-suite");
const office = path.join(pack, "bin", "office.cjs");
/** The managed command MCP configuration limit (src/tool-packages/bind.ts). */
const LIMIT = 8192;

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-office-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("the generated tool bundle matches its recorded build", async () => {
  const build = JSON.parse(
    await readFile(path.join(pack, "bin", "BUILD.json"), "utf8"),
  );
  const bytes = await readFile(office);
  assert.equal(bytes.length, build.bundle.bytes);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    build.bundle.sha256,
  );
});

test("the command MCP configuration fits under a long installation path", async () => {
  const { cliTools } = JSON.parse(
    await readFile(path.join(pack, "cli.json"), "utf8"),
  );
  assert.ok(cliTools.length > 0);
  // A judge who extracts into the Explorer default: a long root plus the store object.
  const root =
    "C:\\Users\\wangxiaoming\\Downloads\\harnesshub-competition-full-windows-x64";
  const entry = path.win32.join(
    root,
    "state\\competition-data\\tool-packages\\objects",
    "0".repeat(64),
    "bin\\office.cjs",
  );
  const encoded = JSON.stringify(
    cliTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      command: path.win32.join(root, "runtime\\node.exe"),
      prefixArgs: [entry, ...(tool.args ?? [])],
    })),
  );
  assert.ok(
    encoded.length < LIMIT,
    `${encoded.length} characters of ${LIMIT}; shorten the descriptions in packs/office-suite/cli.json`,
  );
  // Keep real headroom for a deeper root than the one above.
  assert.ok(
    encoded.length < LIMIT - 512,
    `only ${LIMIT - encoded.length} characters of headroom`,
  );
});

test("the tools write and read back a Word document and a workbook", async (t) => {
  const directory = await temporary(t);
  const node = process.execPath;
  await writeFile(
    path.join(directory, "report.md"),
    "# 周报\n\n本周完成三项工作。\n\n| 项目 | 状态 |\n| --- | --- |\n| 网关 | 完成 |\n",
  );
  await writeFile(
    path.join(directory, "sales.csv"),
    "地区,销量\n华东,120\n华北,80\n",
  );
  const docx = await run(
    node,
    [office, "docx_create", "--input", "report.md", "--output", "周报.docx"],
    { cwd: directory },
  );
  assert.equal(JSON.parse(docx.stdout).ok, true);
  const read = await run(node, [office, "office_read", "周报.docx"], {
    cwd: directory,
  });
  const document = JSON.parse(read.stdout);
  assert.equal(document.kind, "word");
  assert.match(document.content, /周报/);
  assert.match(document.content, /网关/);
  const xlsx = await run(
    node,
    [
      office,
      "xlsx_create",
      "--input",
      "sales.csv",
      "--output",
      "销量.xlsx",
      "--sum",
      "auto",
    ],
    { cwd: directory },
  );
  assert.equal(JSON.parse(xlsx.stdout).ok, true);
  const sheet = JSON.parse(
    (await run(node, [office, "office_read", "销量.xlsx"], { cwd: directory }))
      .stdout,
  );
  assert.equal(sheet.kind, "excel");
  assert.match(sheet.content, /华东,120/);
  assert.match(sheet.content, /合计,200/);
});
