/**
 * Tests for the competition office task suite: scripts/competition-tasks.mjs and its
 * helpers scripts/lib/tasks-zip.mjs, tasks-office.mjs and tasks-verify.mjs.
 * Windows-only probes (tasklist, PowerShell) are exercised with recorded outputs through
 * the injectable `run`, so the policy is tested on every platform.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applySetup,
  decideOutcome,
  defaultTasksFile,
  loadTasks,
  runTasks,
  turnReply,
  usesDesktopState,
  validateTasks,
} from "./competition-tasks.mjs";
import {
  buildDocx,
  buildPptxFixture,
  buildXlsx,
  decodeXml,
  readOffice,
} from "./lib/tasks-office.mjs";
import {
  CHECK_KINDS,
  checkRequirement,
  createVerifier,
  decodeMimeWords,
  decodeTextFile,
  findPaths,
  listProcesses,
  parseCsv,
  parseEml,
  parseIcs,
  powershellJson,
  snapshotHashes,
} from "./lib/tasks-verify.mjs";
import { crc32, readZip, writeZip } from "./lib/tasks-zip.mjs";

const script = fileURLToPath(
  new URL("./competition-tasks.mjs", import.meta.url),
);

async function temporary(t, prefix) {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// Written by Python's zipfile: a deflated entry and a stored entry with a UTF-8 name.
const pythonZip = Buffer.from(
  "UEsDBBQAAAAIAABgM10dbz+6EAAAAPAAAAAJAAAAaGVsbG8udHh0y0jNyclXyMBOcuEQH8KyAFBLAwQUAAAIAAAAYDNdUb0w9A0AAAANAAAAEQAAAOaWh+ahoy/or7TmmI4udHh05Lit5paH5YaF5a65ClBLAQIUAxQAAAAIAABgM10dbz+6EAAAAPAAAAAJAAAAAAAAAAAAAACAAQAAAABoZWxsby50eHRQSwECFAMUAAAIAAAAYDNdUb0w9A0AAAANAAAAEQAAAAAAAAAAAAAAgAE3AAAA5paH5qGjL+ivtOaYji50eHRQSwUGAAAAAAIAAgB2AAAAcwAAAAAA",
  "base64",
);

test("zip reader handles stored and deflated entries from another writer and rejects corrupt archives", () => {
  const foreign = readZip(pythonZip);
  assert.deepEqual(
    foreign.entries.map((entry) => [entry.name, entry.method]),
    [
      ["hello.txt", 8],
      ["文档/说明.txt", 0],
    ],
  );
  assert.equal(
    foreign.read("hello.txt").toString("utf8"),
    "hello hello hello hello hello\n".repeat(8),
  );
  assert.equal(foreign.read("文档/说明.txt").toString("utf8"), "中文内容\n");

  const own = readZip(
    writeZip([
      { name: "a.txt", data: "alpha ".repeat(200) },
      { name: "folder/b.bin", data: Buffer.from([0, 1, 2, 3]), store: true },
      { name: "empty.txt", data: "" },
    ]),
  );
  assert.deepEqual(
    own.entries.map((entry) => entry.method),
    [8, 0, 0],
  );
  assert.equal(own.read("a.txt").toString("utf8"), "alpha ".repeat(200));
  assert.deepEqual([...own.read("folder/b.bin")], [0, 1, 2, 3]);
  assert.equal(own.read("empty.txt").length, 0);
  assert.equal(own.has("missing"), false);
  assert.throws(() => own.read("missing"), { code: "INVALID_ZIP" });
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);

  assert.throws(() => readZip(Buffer.from("not a zip at all, just text")), {
    code: "INVALID_ZIP",
  });
  const corrupt = Buffer.from(pythonZip);
  corrupt[45] ^= 0xff; // inside the deflated data of hello.txt
  assert.throws(() => readZip(corrupt).read("hello.txt"), {
    code: "INVALID_ZIP",
  });
  assert.throws(() => readZip(pythonZip.subarray(0, pythonZip.length - 30)), {
    code: "INVALID_ZIP",
  });
});

test("office readers extract text, tables, slides, cells and formulas and insist on mandatory parts", () => {
  const docx = readOffice(
    buildDocx({
      paragraphs: [{ text: "第38周工作周报", heading: 1 }, "本周完成 A&B <ok>"],
      table: [
        ["任务", "进度"],
        ["接口联调", "80%"],
      ],
    }),
    "docx",
  );
  assert.match(docx.text, /第38周工作周报/);
  assert.match(docx.text, /本周完成 A&B <ok>/);
  assert.match(docx.text, /接口联调/);
  assert.equal(docx.tables, 1);

  const xlsx = readOffice(
    buildXlsx({
      sheets: [
        {
          name: "销售",
          rows: [
            ["产品", "销售额"],
            ["键盘", 13455],
            ["合计", { formula: "SUM(B2:B2)", value: 13455 }],
          ],
        },
        { name: "空表", rows: [] },
      ],
    }),
    "xlsx",
  );
  assert.deepEqual(
    xlsx.sheets.map((sheet) => sheet.name),
    ["销售", "空表"],
  );
  assert.equal(xlsx.sheets[0].cells.get("A2").value, "键盘");
  assert.equal(xlsx.sheets[0].cells.get("B2").value, 13455);
  assert.deepEqual(xlsx.sheets[0].cells.get("B3"), {
    value: 13455,
    formula: "SUM(B2:B2)",
  });
  assert.match(xlsx.text, /合计/);

  // Shared strings, as Excel and most libraries write them.
  const shared = readOffice(
    writeZip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      {
        name: "xl/workbook.xml",
        data: '<workbook xmlns:r="r"><sheets><sheet name="Data" sheetId="1" r:id="rId7"/></sheets></workbook>',
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: '<Relationships><Relationship Id="rId7" Target="worksheets/data.xml"/></Relationships>',
      },
      {
        name: "xl/sharedStrings.xml",
        data: "<sst><si><t>地区</t></si><si><r><t>华</t></r><r><t>东</t></r></si></sst>",
      },
      {
        name: "xl/worksheets/data.xml",
        data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"/><c r="D1" t="b"><v>1</v></c><c r="E1" t="str"><f>A1&amp;"x"</f><v>地区x</v></c></row></sheetData></worksheet>',
      },
    ]),
    "xlsx",
  );
  const cells = shared.sheets[0].cells;
  assert.equal(cells.get("A1").value, "地区");
  assert.equal(cells.get("B1").value, "华东");
  assert.equal(cells.get("D1").value, true);
  assert.deepEqual(cells.get("E1"), { value: "地区x", formula: 'A1&"x"' });

  const pptx = readOffice(
    buildPptxFixture({
      slides: [
        { title: "产品概述", bullets: ["一句话介绍"] },
        { title: "核心功能", bullets: ["文档自动生成", "表格数据分析"] },
      ],
    }),
    "pptx",
  );
  assert.equal(pptx.slides, 2);
  assert.match(pptx.slideTexts[1], /文档自动生成/);

  assert.throws(
    () =>
      readOffice(writeZip([{ name: "word/other.xml", data: "<x/>" }]), "docx"),
    { code: "INVALID_OFFICE_FILE" },
  );
  assert.throws(() => readOffice(Buffer.from("plain text"), "docx"), {
    code: "INVALID_ZIP",
  });
  assert.equal(
    decodeXml("&lt;a&gt; &amp; &#20013;&#x6587; &quot;q&quot;"),
    '<a> & 中文 "q"',
  );
});

test("text, CSV, iCalendar and MIME parsers cope with what office tools write", () => {
  assert.equal(decodeTextFile(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), "a");
  assert.equal(
    decodeTextFile(
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("周报", "utf16le"),
      ]),
    ),
    "周报",
  );
  // "中文" in GBK, as Windows PowerShell 5.1 Set-Content writes on a Chinese system.
  assert.equal(decodeTextFile(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), "中文");

  assert.deepEqual(
    parseCsv(
      '\uFEFF姓名,备注\r\n张伟,"他说 ""好"", 然后\n离开"\r\n\r\n李娜,\n',
    ),
    [
      ["姓名", "备注"],
      ["张伟", '他说 "好", 然后\n离开'],
      ["李娜", ""],
    ],
  );

  const calendar = parseIcs(
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nDTSTART;TZID=Asia/Shanghai:20260925T140000\r\nSUMMARY:项目启\r\n 动会\r\nLOCATION:3号楼\\, 201\r\nBEGIN:VALARM\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nATTENDEE;CN=Wang:mailto:wang.min@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
  );
  assert.equal(calendar.calendar, true);
  assert.equal(calendar.events.length, 1);
  assert.equal(calendar.events[0].get("SUMMARY")[0].value, "项目启动会");
  assert.equal(calendar.events[0].get("LOCATION")[0].value, "3号楼, 201");
  assert.equal(calendar.events[0].has("TRIGGER"), false);

  assert.equal(
    decodeMimeWords(
      "=?utf-8?B?OeaciOmUgOWUrg==?= =?utf-8?Q?=E6=95=B0=E6=8D=AE?=",
    ),
    "9月销售数据",
  );
  const message = parseEml(
    [
      "From: me@example.com",
      "To: =?UTF-8?B?5p2O6Zu3?= <li.lei@example.com>",
      "Subject: =?utf-8?B?OeaciOmUgOWUruaVsOaNrg==?=",
      'Content-Type: multipart/mixed; boundary="==B=="',
      "",
      "--==B==",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("附件是 9 月销售数据，请在周五前反馈。").toString("base64"),
      "--==B==",
      "Content-Type: text/csv",
      "Content-Disposition: attachment; filename*=UTF-8''sales-sept.csv",
      "Content-Transfer-Encoding: base64",
      "",
      "5pel5pyfLOmUgOWUruminQ==",
      "--==B==--",
      "",
    ].join("\r\n"),
  );
  assert.equal(message.headers.get("subject"), "9月销售数据");
  assert.match(message.headers.get("to"), /李雷 <li\.lei@example\.com>/);
  assert.match(message.text, /周五前反馈/);
  assert.deepEqual(message.attachments, ["sales-sept.csv"]);
  const quoted = parseEml(
    'Subject: hi\r\nContent-Type: text/plain; charset="gbk"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n=D6=D0=CE=C4 soft=\r\nbreak\r\n',
  );
  assert.match(quoted.text, /中文 softbreak/);
});

async function officeWorkspace(t) {
  const directory = await temporary(t, "hh-tasks-verify-");
  await applySetup(directory, [
    {
      path: "notes.txt",
      text: "第一行\n第二行\n",
      encoding: "utf16le",
      eol: "crlf",
    },
    { path: "summary.txt", text: "上线日期定为 10 月 15 日，由王敏负责。" },
    {
      path: "data/orders.csv",
      bom: true,
      csv: [
        ["地区", "销售额"],
        ["华东", 3500],
        ["华北", "1,750.5"],
      ],
    },
    {
      path: "totals.json",
      json: { 华东: 3500, 华北: "1750.5", list: [{ id: 1, tag: "a" }] },
    },
    {
      path: "report.docx",
      docx: { paragraphs: ["第38周工作周报", "本周完成"], table: [["a", "b"]] },
    },
    {
      path: "sales.xlsx",
      xlsx: {
        sheets: [
          {
            name: "Sheet1",
            rows: [
              ["产品", "销售额"],
              ["键盘", 13455],
              ["合计", { formula: "SUM(B2:B2)" }],
            ],
          },
        ],
      },
    },
    { path: "empty-dir", directory: true },
    { path: "big.bin", repeat: { text: "0123456789", count: 120 } },
    { path: "pixel.png", base64: "iVBORw0KGgo=" },
  ]);
  await writeFile(
    path.join(directory, "deck.pptx"),
    buildPptxFixture({
      slides: [
        { title: "产品概述" },
        { title: "核心功能" },
        { title: "上线计划" },
      ],
    }),
  );
  await writeFile(
    path.join(directory, "kickoff.ics"),
    "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260925T060000Z\nDTEND:20260925T073000Z\nSUMMARY:项目启动会\nLOCATION:3号楼201会议室\nATTENDEE:mailto:Wang.Min@example.com\nEND:VEVENT\nEND:VCALENDAR\n",
  );
  await writeFile(
    path.join(directory, "draft.eml"),
    'To: li.lei@example.com\nSubject: =?utf-8?B?OeaciOmUgOWUruaVsOaNrg==?=\nContent-Type: multipart/mixed; boundary="x"\n\n--x\nContent-Type: text/plain; charset=utf-8\n\n请在周五前反馈。\n--x\nContent-Type: text/csv; name="sales-sept.csv"\nContent-Disposition: attachment\n\na,b\n--x--\n',
  );
  await writeFile(
    path.join(directory, "docs-backup.zip"),
    writeZip([
      { name: "docs/readme.txt", data: "说明" },
      { name: "docs/plan.md", data: "# 计划" },
    ]),
  );
  return directory;
}

test("every file-based check kind passes on a correct state and explains a wrong one", async (t) => {
  const directory = await officeWorkspace(t);
  const baseline = await snapshotHashes(directory);
  const verify = createVerifier();
  const context = {
    directory,
    reply: "已完成，文件保存在 summary.txt。",
    baseline,
  };
  const run = (check) => verify(check, context);
  const passes = [
    { kind: "file_exists", path: "summary.txt", min_bytes: 10 },
    { kind: "file_exists", path: "DATA/*.csv" },
    { kind: "file_exists", path: "**/*.csv", min_count: 1, max_count: 1 },
    { kind: "file_exists", path: "empty-dir", directory: true },
    { kind: "file_absent", path: "missing.txt" },
    { kind: "file_absent", path: "orders.csv" },
    {
      kind: "file_text_contains",
      path: "summary.txt",
      contains: ["王敏"],
      any: ["10月15日", "10/15"],
      min_chars: 5,
      max_chars: 100,
    },
    { kind: "file_text_contains", path: "notes.txt", contains: ["第二行"] },
    { kind: "file_text_equals", path: "notes.txt", equals: "第一行\n第二行" },
    {
      kind: "file_text_matches",
      path: "notes.txt",
      pattern: "^第.行\\s*$",
      min_matches: 2,
    },
    {
      kind: "office_text_contains",
      path: "report.docx",
      contains: ["第38周工作周报", "本周完成"],
      min_tables: 1,
      min_paragraphs: 2,
    },
    {
      kind: "office_text_contains",
      path: "deck.pptx",
      contains: ["核心功能"],
      min_slides: 3,
    },
    { kind: "office_text_contains", path: "sales.xlsx", contains: ["合计"] },
    { kind: "xlsx_cell", path: "sales.xlsx", cell: "b2", number: 13455 },
    {
      kind: "xlsx_cell",
      path: "sales.xlsx",
      sheet: "sheet1",
      cell: "A3",
      equals: "合计",
    },
    {
      kind: "xlsx_cell",
      path: "sales.xlsx",
      sheet: 0,
      cell: "B3",
      formula: true,
      formula_contains: "sum",
    },
    { kind: "xlsx_find", path: "sales.xlsx", formula_contains: "SUM" },
    { kind: "xlsx_find", path: "sales.xlsx", number: 13455 },
    {
      kind: "csv_rows",
      path: "data/orders.csv",
      header: ["地区", "销售额"],
      row_count: 2,
      min_rows: 1,
      max_rows: 5,
      unique_by: "地区",
      contains_rows: [["华北", "1,750.5"]],
    },
    {
      kind: "csv_rows",
      path: "data/orders.csv",
      header: ["销售额", "地区"],
      header_any_order: true,
    },
    {
      kind: "json_valid",
      path: "totals.json",
      has_keys: ["华东"],
      subset: { 华东: 3500, 华北: 1750.5, list: [{ tag: "a" }] },
    },
    {
      kind: "ics_valid",
      path: "kickoff.ics",
      summary_contains: "项目启动会",
      dtstart: ["20260925T1400", "20260925T0600"],
      dtend: "20260925T0730",
      location_contains: "201",
      attendee_contains: ["wang.min@example.com"],
    },
    {
      kind: "eml_headers",
      path: "draft.eml",
      headers: { To: "li.lei@example.com", Subject: "9月销售数据" },
      body_contains: ["周五"],
      attachment_names: ["sales-sept.csv"],
    },
    {
      kind: "zip_contains",
      path: "docs-backup.zip",
      entries: ["readme.txt", "docs/plan.md"],
      min_entries: 2,
    },
    { kind: "not_modified", path: "report.docx" },
    {
      kind: "reply_contains",
      contains: ["已完成"],
      any: ["summary.txt", "摘要"],
    },
    { kind: "reply_matches", pattern: "SUMMARY\\.txt" },
    {
      kind: "all_of",
      checks: [
        { kind: "file_exists", path: "big.bin" },
        { kind: "file_exists", path: "pixel.png" },
      ],
    },
    {
      kind: "any_of",
      checks: [
        { kind: "file_exists", path: "nope" },
        { kind: "file_exists", path: "big.bin" },
      ],
    },
    { kind: "not", check: { kind: "file_exists", path: "nope" } },
  ];
  for (const check of passes) {
    const outcome = await run(check);
    assert.equal(
      outcome.ok,
      true,
      `${JSON.stringify(check)} -> ${outcome.summary}`,
    );
  }

  const failures = [
    [{ kind: "file_exists", path: "missing.docx" }, /found 0/],
    [
      { kind: "file_exists", path: "summary.txt", min_bytes: 100000 },
      /smaller than/,
    ],
    [{ kind: "file_absent", path: "summary.txt" }, /still exists/],
    [
      { kind: "file_text_contains", path: "summary.txt", contains: ["赵磊"] },
      /does not contain/,
    ],
    [
      { kind: "file_text_contains", path: "summary.txt", any: ["11月"] },
      /contains none of/,
    ],
    [
      { kind: "file_text_contains", path: "summary.txt", max_chars: 5 },
      /more than 5/,
    ],
    [
      { kind: "file_text_equals", path: "notes.txt", equals: "别的" },
      /expected/,
    ],
    [
      {
        kind: "file_text_matches",
        path: "notes.txt",
        pattern: "^- \\[ \\]",
        min_matches: 3,
      },
      /matched 0/,
    ],
    [
      {
        kind: "office_text_contains",
        path: "report.docx",
        contains: ["下周计划"],
      },
      /does not contain/,
    ],
    [
      { kind: "office_text_contains", path: "report.docx", min_tables: 2 },
      /has 1 tables/,
    ],
    [
      { kind: "office_text_contains", path: "deck.pptx", min_slides: 4 },
      /has 3 slides/,
    ],
    [
      { kind: "office_text_contains", path: "summary.txt", contains: ["x"] },
      /not a docx/,
    ],
    [
      {
        kind: "office_text_contains",
        path: "pixel.png",
        format: "docx",
        contains: ["x"],
      },
      /ZIP/,
    ],
    [
      { kind: "xlsx_cell", path: "sales.xlsx", cell: "B2", number: 1 },
      /is not 1/,
    ],
    [
      { kind: "xlsx_cell", path: "sales.xlsx", cell: "B2", formula: true },
      /no formula/,
    ],
    [
      { kind: "xlsx_cell", path: "sales.xlsx", cell: "Z9", equals: "x" },
      /cell is empty/,
    ],
    [
      { kind: "xlsx_cell", path: "sales.xlsx", sheet: "其他", cell: "A1" },
      /no sheet/,
    ],
    [
      { kind: "xlsx_find", path: "sales.xlsx", formula_contains: "AVERAGE" },
      /no cell matches/,
    ],
    [
      { kind: "csv_rows", path: "data/orders.csv", header: ["地区"] },
      /header is/,
    ],
    [
      { kind: "csv_rows", path: "data/orders.csv", row_count: 3 },
      /has 2 data rows/,
    ],
    [
      { kind: "csv_rows", path: "data/orders.csv", contains_rows: [["华南"]] },
      /no row with/,
    ],
    [
      { kind: "csv_rows", path: "data/orders.csv", unique_by: "城市" },
      /no column/,
    ],
    [{ kind: "json_valid", path: "summary.txt" }, /not valid JSON/],
    [
      { kind: "json_valid", path: "totals.json", subset: { 华东: 1 } },
      /expected 1/,
    ],
    [{ kind: "json_valid", path: "totals.json", has_keys: ["西南"] }, /no key/],
    [
      { kind: "ics_valid", path: "kickoff.ics", dtstart: "20260926" },
      /DTSTART is/,
    ],
    [
      {
        kind: "ics_valid",
        path: "kickoff.ics",
        attendee_contains: "li@example.com",
      },
      /no ATTENDEE/,
    ],
    [{ kind: "ics_valid", path: "summary.txt" }, /VCALENDAR/],
    [
      { kind: "eml_headers", path: "draft.eml", headers: { Cc: "a@b" } },
      /no Cc header/,
    ],
    [
      {
        kind: "eml_headers",
        path: "draft.eml",
        attachment_names: ["other.csv"],
      },
      /no attachment named/,
    ],
    [
      { kind: "zip_contains", path: "docs-backup.zip", entries: ["data.csv"] },
      /no entry data\.csv/,
    ],
    [{ kind: "zip_contains", path: "summary.txt", entries: ["a"] }, /ZIP/],
    [
      { kind: "not_modified", path: "never-there.txt" },
      /not part of the task setup/,
    ],
    [{ kind: "reply_contains", contains: ["未安装"] }, /does not contain/],
    [{ kind: "reply_matches", pattern: "^失败" }, /does not match/],
    [
      {
        kind: "any_of",
        checks: [
          { kind: "file_exists", path: "a" },
          { kind: "file_exists", path: "b" },
        ],
      },
      /\|/,
    ],
    [
      { kind: "not", check: { kind: "file_exists", path: "big.bin" } },
      /unexpectedly true/,
    ],
    [{ kind: "file_exists", path: "../outside.txt" }, /must stay inside/],
    [
      { kind: "file_exists", path: path.join(directory, "summary.txt") },
      /must stay inside/,
    ],
    [{ kind: "teleport" }, /unknown check kind/],
    [{ checks: [] }, /must be an object with a kind/],
    [{ kind: "all_of", checks: [] }, /needs checks/],
  ];
  for (const [check, expected] of failures) {
    const outcome = await run(check);
    assert.equal(outcome.ok, false, JSON.stringify(check));
    assert.match(outcome.summary, expected, JSON.stringify(check));
  }

  await writeFile(path.join(directory, "report.docx"), "overwritten");
  assert.match(
    (await run({ kind: "not_modified", path: "report.docx" })).summary,
    /was modified/,
  );
  await rm(path.join(directory, "report.docx"));
  assert.match(
    (await run({ kind: "not_modified", path: "report.docx" })).summary,
    /was deleted/,
  );

  assert.deepEqual(
    (await findPaths(directory, "data/*")).map((entry) => entry.relative),
    ["data/orders.csv"],
  );
  const kinds = new Set(
    [...passes, ...failures.map(([check]) => check)].map((check) => check.kind),
  );
  for (const kind of CHECK_KINDS)
    if (!["process_running", "window_title", "shell_window"].includes(kind))
      assert.ok(kinds.has(kind), `check kind ${kind} is exercised`);
});

test("placeholders expand to this machine's names", async (t) => {
  const directory = await temporary(t, "hh-tasks-vars-");
  await writeFile(
    path.join(directory, "system-info.txt"),
    `user=${os.userInfo().username.toUpperCase()} host=${os.hostname()}`,
  );
  const verify = createVerifier();
  const outcome = await verify(
    {
      kind: "file_text_contains",
      path: "system-info.txt",
      contains: ["${username}"],
      any: ["${hostname}", "${computer_name}"],
    },
    { directory, reply: "" },
  );
  assert.equal(outcome.ok, true, outcome.summary);
  const literal = await verify(
    {
      kind: "file_text_contains",
      path: "system-info.txt",
      contains: ["${unknown_name}"],
    },
    { directory, reply: "" },
  );
  assert.match(literal.summary, /\$\{unknown_name\}/);
});

/** Recorded Windows tool outputs keyed by what the verifier runs. */
function windowsRunner(state) {
  const json = (value) => ({
    code: 0,
    stdout: Buffer.from(
      `WARNING: noise before JSON\r\n${JSON.stringify(value).replace(/[^\x00-\x7f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}\r\n`,
    ),
    stderr: Buffer.alloc(0),
  });
  return async (command, args) => {
    state.calls.push([path.win32.basename(command), ...args.slice(0, 3)]);
    if (/tasklist\.exe$/i.test(command))
      return {
        code: 0,
        stdout: Buffer.from(
          '"System Idle Process","0","Services","0","8 K"\r\n"Notepad.exe","4321","Console","1","12,345 K"\r\n"msedge.exe","5000","Console","1","99,000 K"\r\n',
        ),
        stderr: Buffer.alloc(0),
      };
    const scriptText = Buffer.from(args.at(-1), "base64").toString("utf16le");
    state.scripts.push(scriptText);
    if (scriptText.includes("Win32_Process"))
      return json({
        items: [
          {
            pid: 4321,
            name: "Notepad.exe",
            commandLine:
              '"C:\\Windows\\notepad.exe" "D:\\eval\\任务 1\\notes.txt"',
          },
          {
            pid: 5000,
            name: "msedge.exe",
            commandLine: "msedge.exe --type=renderer",
          },
        ],
      });
    if (scriptText.includes("MainWindowTitle"))
      return json({
        items: [{ pid: 4321, name: "Notepad", title: "notes.txt - 记事本" }],
      });
    if (scriptText.includes("Shell.Application"))
      return json({ items: ["D:\\eval\\任务 1\\reports\\"] });
    if (scriptText.includes("App Paths"))
      return json({
        found: state.installed ? ["app-path:C:\\Office\\OUTLOOK.EXE"] : [],
      });
    return {
      code: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("unexpected script"),
    };
  };
}

test("Windows desktop checks parse tasklist, CIM, window titles and Explorer windows", async (t) => {
  const directory = await temporary(t, "hh-tasks-win-");
  const state = { calls: [], scripts: [], installed: false };
  const run = windowsRunner(state);
  const env = { SystemRoot: "C:\\Windows" };
  const verify = createVerifier({ platform: "win32", run, env });
  const context = { directory, reply: "" };
  const ok = async (check) => {
    const outcome = await verify(check, context);
    assert.equal(
      outcome.ok,
      true,
      `${JSON.stringify(check)} -> ${outcome.summary}`,
    );
  };
  await ok({ kind: "process_running", names: ["OUTLOOK", "notepad.exe"] });
  await ok({
    kind: "process_running",
    names: ["notepad"],
    command_line_contains: "NOTES.TXT",
  });
  await ok({ kind: "window_title", names: ["notepad"], contains: ["记事本"] });
  await ok({ kind: "shell_window", path_ends_with: "reports" });
  const notRunning = await verify(
    { kind: "process_running", names: ["OUTLOOK", "olk"] },
    context,
  );
  assert.match(notRunning.summary, /none of outlook, olk is running/);
  const wrongFile = await verify(
    {
      kind: "process_running",
      names: ["msedge"],
      command_line_contains: "page.html",
    },
    context,
  );
  assert.match(wrongFile.summary, /no command line contains/);
  assert.match(
    (await verify({ kind: "window_title", contains: ["Outlook"] }, context))
      .summary,
    /no window title contains/,
  );
  assert.match(
    (
      await verify(
        { kind: "shell_window", path_ends_with: "invoices" },
        context,
      )
    ).summary,
    /no Explorer window/,
  );
  assert.equal(state.calls[0][0], "tasklist.exe");
  assert.ok(
    state.calls.some(
      (call) => call[0] === "powershell.exe" && call.includes("-NoProfile"),
    ),
  );
  assert.ok(state.scripts.every((text) => text.includes("ConvertTo-Json")));

  const spec = {
    kind: "app_installed",
    app_paths: ["OUTLOOK.EXE"],
    commands: ["outlook.exe"],
    appx: ["Microsoft.OutlookForWindows"],
  };
  assert.deepEqual(
    await checkRequirement(spec, { platform: "win32", run, env }),
    {
      satisfied: false,
      evidence: [],
    },
  );
  state.installed = true;
  assert.equal(
    (await checkRequirement(spec, { platform: "win32", run, env })).satisfied,
    true,
  );
  assert.match(state.scripts.at(-1), /OUTLOOK\.EXE/);
  await assert.rejects(
    checkRequirement({ kind: "registry" }, { platform: "win32", run, env }),
  );
  await assert.rejects(
    powershellJson("$result = 1", {
      run: async () => ({
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("boom"),
      }),
      env,
    }),
    /PowerShell failed \(1\): boom/,
  );

  // On other platforms the Windows-only checks fail with a clear reason instead of passing.
  const posix = createVerifier({ platform: "linux" });
  assert.match(
    (await posix({ kind: "window_title", contains: ["x"] }, context)).summary,
    /only supported on Windows/,
  );
  assert.match(
    (await posix({ kind: "shell_window", path_ends_with: "x" }, context))
      .summary,
    /only supported on Windows/,
  );
});

test("the real process list of this machine contains the test runner", async () => {
  const processes = await listProcesses();
  assert.ok(
    processes.some((item) => item.pid === process.pid),
    "own pid is listed",
  );
  const own = path
    .basename(process.execPath)
    .replace(/\.exe$/i, "")
    .toLowerCase();
  const verify = createVerifier();
  const outcome = await verify(
    { kind: "process_running", names: [own] },
    { directory: os.tmpdir(), reply: "" },
  );
  assert.equal(outcome.ok, true, outcome.summary);
  const withArguments = await verify(
    {
      kind: "process_running",
      names: [own],
      command_line_contains: "check-competition-tasks",
    },
    { directory: os.tmpdir(), reply: "" },
  );
  assert.equal(withArguments.ok, true, withArguments.summary);
});

test("outcome policy: PASS needs a verified state and 204; ENV needs an unmet requirement and an honest reply", () => {
  const met = [{ satisfied: true }];
  const unmet = [{ satisfied: false }];
  const decide = (evidence) =>
    decideOutcome({ honest: false, requirements: [], ...evidence }).outcome;
  assert.equal(decide({ httpStatus: 204, verifyOk: true }), "PASS");
  assert.equal(
    decide({ httpStatus: 204, verifyOk: true, requirements: unmet }),
    "PASS",
  );
  assert.equal(decide({ httpStatus: 204, verifyOk: false }), "FAIL");
  assert.equal(decide({ httpStatus: 502, verifyOk: true }), "FAIL");
  assert.equal(decide({ httpStatus: null, verifyOk: true }), "FAIL");
  assert.equal(
    decide({
      httpStatus: 204,
      verifyOk: false,
      requirements: unmet,
      honest: true,
    }),
    "ENV",
  );
  assert.equal(
    decide({
      httpStatus: 204,
      verifyOk: false,
      requirements: unmet,
      honest: false,
    }),
    "FAIL",
  );
  assert.equal(
    decide({
      httpStatus: 204,
      verifyOk: false,
      requirements: met,
      honest: true,
    }),
    "FAIL",
  );
  assert.equal(
    decide({
      httpStatus: 204,
      verifyOk: true,
      error: "POST /session returned 500",
    }),
    "FAIL",
  );
  assert.match(
    decideOutcome({
      httpStatus: 204,
      verifyOk: false,
      requirements: unmet,
      honest: false,
    }).reason,
    /did not report it/,
  );
});

test("the shipped suite is valid, judge-shaped and covers every task family; invalid files list every problem", async () => {
  const document = await loadTasks(defaultTasksFile);
  assert.ok(document.tasks.length >= 16 && document.tasks.length <= 20);
  const sample = document.tasks.find((task) => task.task_id === "office_002");
  assert.equal(sample.query, "请自动打开 Outlook 邮件客户端");
  assert.equal(sample.category, "办公协作、沟通与日程管理类");
  assert.equal(sample.secondary_category, "软件交互");
  assert.ok(sample.requires && sample.env_reply);
  for (const task of document.tasks) {
    for (const field of [
      "task_id",
      "title",
      "description",
      "query",
      "category",
      "secondary_category",
      "difficulty_label",
    ])
      assert.equal(typeof task[field], "string", `${task.task_id}.${field}`);
    assert.ok(task.difficulty >= 1 && task.difficulty <= 4, task.task_id);
    // Desktop checks only exist on Windows; such tasks must not run elsewhere.
    if (usesDesktopState(task.verify))
      assert.deepEqual(task.platform, ["win32"], task.task_id);
    // A judge never names our tools in a query.
    assert.doesNotMatch(
      task.query,
      /cli_|mcp|powershell|python|node\b/i,
      task.task_id,
    );
  }
  assert.deepEqual(
    [...new Set(document.tasks.map((task) => task.secondary_category))].sort(),
    [
      "文件管理",
      "文档处理",
      "沟通与日程",
      "演示文稿",
      "系统信息",
      "表格与数据",
      "软件交互",
    ].sort(),
  );

  const problems = validateTasks({
    tasks: [
      { task_id: "a", title: "t", query: "q", verify: { kind: "teleport" } },
      {
        task_id: "a",
        title: "t",
        query: "",
        verify: { kind: "any_of", checks: [] },
        platform: ["beos"],
      },
      {
        task_id: "b",
        title: "t",
        query: "q",
        verify: { kind: "file_exists", path: "x" },
        requires: [{ kind: "registry" }],
        setup: [{ path: "x" }, { text: "no path" }],
        cleanup: [{ kind: "reboot" }],
      },
      "not a task",
    ],
  });
  for (const expected of [
    /unknown check kind teleport/,
    /duplicate task_id/,
    /query must be a non-empty string/,
    /any_of needs a non-empty checks array/,
    /unknown platform beos/,
    /kind must be app_installed/,
    /requires needs env_reply/,
    /setup\[0\]: needs a path and exactly one of/,
    /setup\[1\]: needs a path/,
    /only \{kind:"close_process"/,
    /tasks\[3\]: must be an object/,
  ])
    assert.ok(
      problems.some((problem) => expected.test(problem)),
      `${expected} in ${JSON.stringify(problems)}`,
    );
  assert.deepEqual(validateTasks({ tasks: [] }), [
    "Task file must be an object with a non-empty tasks array",
  ]);
});

test("setup writes the declared encodings and refuses paths outside the task directory", async (t) => {
  const directory = await temporary(t, "hh-tasks-setup-");
  await applySetup(directory, [
    {
      path: "bom.csv",
      bom: true,
      csv: [
        ["a", "b"],
        ['x "y"', "1,5"],
      ],
    },
    { path: "plain.txt", text: "一\n二\n", eol: "crlf" },
    { path: "sub/dir/u16.txt", text: "中", encoding: "utf16le" },
  ]);
  const csv = await readFile(path.join(directory, "bom.csv"));
  assert.deepEqual([...csv.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(csv.subarray(3).toString("utf8"), 'a,b\r\n"x ""y""","1,5"\r\n');
  assert.equal(
    await readFile(path.join(directory, "plain.txt"), "utf8"),
    "一\r\n二\r\n",
  );
  assert.deepEqual(
    [...(await readFile(path.join(directory, "sub/dir/u16.txt")))],
    [0xff, 0xfe, 0x2d, 0x4e],
  );
  await assert.rejects(
    applySetup(directory, [{ path: "../escape.txt", text: "x" }]),
    /must stay inside/,
  );
  await assert.rejects(
    applySetup(directory, [
      { path: path.join(directory, "abs.txt"), text: "x" },
    ]),
    /must stay inside/,
  );
  await assert.rejects(
    applySetup(directory, [{ path: "gbk.txt", text: "x", encoding: "gbk" }]),
    /Unsupported setup encoding/,
  );
});

test("turnReply joins only the assistant text of the last turn in both message shapes", () => {
  assert.equal(
    turnReply([
      { role: "user", content: "old" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new" },
      {
        role: "assistant",
        content: "",
        parts: [{ type: "tool", tool: "bash" }],
      },
      { role: "tool", content: "ignored" },
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", content: "已创建 todo.md" },
          { type: "step-finish" },
        ],
      },
      { role: "assistant", content: "完成。" },
    ]),
    "已创建 todo.md\n完成。",
  );
  assert.equal(turnReply([]), "");
});

/**
 * In-process stand-in for the competition API. `agent(query, directory, state)` plays the
 * engine: it may write files and returns `{reply, status?}`.
 */
async function fakeCompetitionApi(t, agent) {
  const state = {
    sessions: new Map(),
    prompts: [],
    deleted: [],
    open: new Set(),
  };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : undefined;
    const send = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(value === undefined ? "" : JSON.stringify(value));
    };
    const url = new URL(request.url, "http://localhost");
    const match = /^\/session\/([^/]+)(\/[a-z_]+)?$/.exec(url.pathname);
    if (url.pathname === "/health/ready") return send(200, { ready: true });
    if (url.pathname === "/v1/runtime/info")
      return send(200, {
        competition: true,
        competitionEngine: "fake agent",
        fullAccess: true,
      });
    if (url.pathname === "/v1/harness/model")
      return send(200, { configured: true, model: "sim-model" });
    if (request.method === "POST" && url.pathname === "/session") {
      const id = `s${state.sessions.size + 1}`;
      state.sessions.set(id, { ...body, messages: [] });
      state.open.add(id);
      return send(200, {
        id,
        title: body.title,
        directory: body.directory,
        status: "idle",
      });
    }
    if (match && request.method === "POST" && match[2] === "/prompt_async") {
      const session = state.sessions.get(match[1]);
      const query = body.parts[0].text;
      state.prompts.push({ id: match[1], query, model: body.model });
      const outcome = await agent(query, session.directory, state);
      session.messages.push(
        { id: "u", role: "user", content: query },
        {
          id: "a1",
          role: "assistant",
          content: "",
          info: { role: "assistant", finish: "tool-calls" },
          parts: [
            { type: "tool", tool: "bash", state: { status: "completed" } },
            { type: "step-finish" },
          ],
        },
        {
          id: "a2",
          role: "assistant",
          content: outcome.reply,
          info: {
            role: "assistant",
            finish: outcome.status === 502 ? "error" : "stop",
          },
          parts: [
            { type: "text", content: outcome.reply },
            { type: "step-finish" },
          ],
        },
      );
      if (outcome.status === 502)
        return send(502, { code: "BAD_GATEWAY", message: "engine failed" });
      response.writeHead(204);
      return response.end();
    }
    if (match && request.method === "GET" && match[2] === "/message")
      return send(200, state.sessions.get(match[1]).messages);
    if (match && request.method === "DELETE" && !match[2]) {
      state.deleted.push(match[1]);
      state.open.delete(match[1]);
      return send(200, { ok: true });
    }
    if (/^\/v1\/sessions\/[^/]+\/runs$/.test(url.pathname))
      return send(200, { runs: [{ id: "run-1", status: "completed" }] });
    if (/^\/v1\/runs\/run-1\/event-log$/.test(url.pathname))
      return send(200, {
        events: [
          {
            type: "model.call",
            data: { upstreamModel: "sim-model", ok: true },
          },
          { type: "engine.output", data: {} },
          {
            type: "model.call",
            data: { upstreamModel: "sim-model", ok: true },
          },
        ],
      });
    return send(404, { code: "NOT_FOUND", message: url.pathname });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, state };
}

const suite = {
  suite: "fixture",
  tasks: [
    {
      task_id: "todo_1",
      title: "待办",
      query: "请整理待办清单 todo.md",
      category: "协作",
      secondary_category: "沟通与日程",
      difficulty: 1,
      setup: [{ path: "input.txt", text: "事项\n" }],
      verify: {
        kind: "all_of",
        checks: [
          {
            kind: "file_text_matches",
            path: "todo.md",
            pattern: "^- \\[ \\] ",
            min_matches: 2,
          },
          { kind: "not_modified", path: "input.txt" },
        ],
      },
    },
    {
      task_id: "lazy_1",
      title: "偷懒",
      query: "请生成 report.docx",
      verify: { kind: "file_exists", path: "report.docx" },
    },
    {
      task_id: "outlook_1",
      title: "打开Outlook",
      query: "请自动打开 Outlook 邮件客户端",
      verify: { kind: "file_exists", path: "outlook-is-running.flag" },
      requires: [{ kind: "app_installed", app_paths: ["OUTLOOK.EXE"] }],
      env_reply: { any: ["未安装"] },
    },
    {
      task_id: "liar_1",
      title: "谎报",
      query: "请打开 Visio",
      verify: { kind: "file_exists", path: "visio-is-running.flag" },
      requires: [{ kind: "app_installed", app_paths: ["VISIO.EXE"] }],
      env_reply: { any: ["未安装"], pattern: "not\\s+installed" },
    },
    {
      task_id: "crash_1",
      title: "崩溃",
      query: "请让引擎崩溃",
      verify: { kind: "file_exists", path: "crash.txt" },
    },
    {
      task_id: "other_os",
      title: "别的系统",
      query: "只在 BeOS 上运行",
      platform: [process.platform === "win32" ? "linux" : "win32"],
      verify: { kind: "file_exists", path: "x" },
    },
  ],
};

async function scriptedAgent(query, directory) {
  if (query.includes("todo.md")) {
    await writeFile(
      path.join(directory, "todo.md"),
      "- [ ] 提交报销单\n- [ ] 回复客户邮件\n",
    );
    return { reply: "已创建 todo.md。" };
  }
  if (query.includes("Outlook"))
    return { reply: "这台电脑未安装 Outlook，无法打开。" };
  if (query.includes("Visio")) return { reply: "Visio 已经打开。" };
  if (query.includes("崩溃")) {
    await writeFile(
      path.join(directory, "crash.txt"),
      "written before the failure",
    );
    return { reply: "", status: 502 };
  }
  return { reply: "好的。" };
}

test("runner plays the judge against a competition API: verbatim queries, fresh directories, PASS/FAIL/ENV/SKIP, reports", async (t) => {
  const out = await temporary(t, "hh-tasks-run-");
  const { base, state } = await fakeCompetitionApi(t, scriptedAgent);
  const summaryFile = path.join(out, "summary.md");
  const seen = [];
  const result = await runTasks({
    base: `${base}/`,
    out,
    tasks: suite,
    workRoot: path.join(out, "work root with spaces"),
    summaryFile,
    requirement: async () => ({ satisfied: false, evidence: [] }),
    onTask: (record) => seen.push(record.task_id),
  });
  assert.deepEqual(
    Object.fromEntries(
      result.tasks.map((task) => [task.task_id, task.outcome]),
    ),
    {
      todo_1: "PASS",
      lazy_1: "FAIL",
      outlook_1: "ENV",
      liar_1: "FAIL",
      crash_1: "FAIL",
      other_os: "SKIP",
    },
  );
  assert.deepEqual(result.totals, { PASS: 1, FAIL: 3, ENV: 1, SKIP: 1 });
  assert.equal(result.label, "fake_agent");
  assert.equal(result.model, "sim-model");
  assert.deepEqual(
    seen,
    suite.tasks.map((task) => task.task_id),
  );

  // Queries arrive verbatim, one Session per task, each in its own new directory.
  assert.deepEqual(
    state.prompts.map((prompt) => prompt.query),
    suite.tasks.slice(0, 5).map((task) => task.query),
  );
  assert.deepEqual(state.prompts[0].model, {
    providerID: "harnesshub",
    modelID: "sim-model",
  });
  const sessions = [...state.sessions.values()];
  assert.equal(sessions[0].title, "todo_1-待办");
  assert.equal(new Set(sessions.map((session) => session.directory)).size, 5);
  for (const session of sessions)
    assert.ok(
      session.directory.startsWith(
        path.join(out, "work root with spaces", "fake_agent"),
      ),
    );
  assert.deepEqual(state.deleted, ["s1", "s2", "s3", "s4", "s5"]);

  const [todo, lazy, outlook, liar, crash, skipped] = result.tasks;
  assert.equal(todo.httpStatus, 204);
  assert.equal(todo.finish, "stop");
  assert.deepEqual(todo.tools, ["bash:completed"]);
  assert.equal(todo.modelCalls, 2);
  assert.deepEqual(todo.upstreamModels, ["sim-model"]);
  assert.equal(todo.reply, "已创建 todo.md。");
  assert.equal(todo.survivesSessionClose, null);
  assert.match(lazy.notes.join(" "), /found 0/);
  assert.match(
    outlook.reason,
    /lacks what the task needs and the agent said so/,
  );
  assert.match(liar.reason, /did not report it/);
  assert.equal(crash.httpStatus, 502);
  assert.equal(crash.verify.ok, true);
  assert.match(crash.reason, /prompt_async returned 502/);
  assert.match(skipped.reason, /runs only on/);
  assert.equal(skipped.directory, null);

  const written = JSON.parse(
    await readFile(path.join(out, "tasks-fake_agent.json"), "utf8"),
  );
  assert.deepEqual(written.totals, result.totals);
  const table = await readFile(path.join(out, "tasks-fake_agent.md"), "utf8");
  assert.match(table, /\| todo_1 待办 \| 沟通与日程 \| 1 \| \*\*PASS\*\* \|/);
  assert.match(table, /\*\*ENV\*\*/);
  assert.match(table, /Survives close/);
  assert.equal(await readFile(summaryFile, "utf8"), `${table}\n`);

  const only = await runTasks({
    base,
    out: path.join(out, "only"),
    tasks: suite,
    only: ["todo_1"],
    label: "picked",
  });
  assert.deepEqual(
    only.tasks.map((task) => task.task_id),
    ["todo_1"],
  );
  await assert.rejects(
    runTasks({ base, out, tasks: suite, only: ["nope"] }),
    /unknown tasks: nope/,
  );
  await assert.rejects(
    runTasks({ base: "http://127.0.0.1:9", out, tasks: suite }),
    /Gateway is not ready/,
  );
  await assert.rejects(
    runTasks({ base, out, tasks: { tasks: [{ task_id: "x" }] } }),
    /Invalid tasks/,
  );
});

test("desktop tasks are checked again after DELETE /session and only then cleaned up", async (t) => {
  const out = await temporary(t, "hh-tasks-survival-");
  const { base, state } = await fakeCompetitionApi(t, async () => ({
    reply: "已打开。",
  }));
  // The "app" lives inside the Session's process Job: it is gone once the Session closes.
  const jobbed = () =>
    state.open.size ? [{ pid: 2 ** 30, name: "fakeapp" }] : [];
  const detached = () => [{ pid: 2 ** 30 + 1, name: "fakeapp" }];
  let listing = jobbed;
  const calls = [];
  const verifier = async (check) => {
    calls.push(state.open.size ? "open" : "closed");
    const running = listing().some((item) => check.names.includes(item.name));
    return {
      kind: check.kind,
      ok: running,
      summary: running ? "ok" : "none of fakeapp is running",
    };
  };
  const desktop = {
    tasks: [
      {
        task_id: "app_1",
        title: "打开应用",
        query: "请打开应用",
        verify: { kind: "process_running", names: ["fakeapp"] },
        cleanup: [{ kind: "close_process", names: ["fakeapp"] }],
      },
    ],
  };
  const options = {
    base,
    out,
    tasks: desktop,
    verifier,
    survivalDelayMs: 10,
    processes: async () => listing(),
    label: "desk",
  };

  const lost = await runTasks(options);
  assert.equal(lost.tasks[0].outcome, "PASS");
  assert.equal(lost.tasks[0].survivesSessionClose, false);
  assert.match(
    lost.tasks[0].notes.join(" "),
    /after DELETE \/session: none of fakeapp/,
  );
  assert.deepEqual(calls, ["open", "closed"]);
  assert.match(
    await readFile(path.join(out, "tasks-desk.md"), "utf8"),
    /\*\*no\*\*/,
  );

  const strict = await runTasks({ ...options, requireSurvival: true });
  assert.equal(strict.tasks[0].outcome, "FAIL");
  assert.match(strict.tasks[0].reason, /did not survive DELETE \/session/);
  assert.deepEqual(strict.totals, { PASS: 0, FAIL: 1, ENV: 0, SKIP: 0 });

  listing = detached;
  const kept = await runTasks({ ...options, requireSurvival: true });
  assert.equal(kept.tasks[0].outcome, "PASS");
  assert.equal(kept.tasks[0].survivesSessionClose, true);
  assert.equal(
    usesDesktopState({
      kind: "any_of",
      checks: [
        { kind: "file_exists", path: "x" },
        { kind: "not", check: { kind: "window_title", contains: ["x"] } },
      ],
    }),
    true,
  );
  assert.equal(usesDesktopState({ kind: "file_exists", path: "x" }), false);
});

test("command line: usage errors exit 2, a failing task exits 1, a clean run exits 0", async (t) => {
  const out = await temporary(t, "hh-tasks-cli-");
  const { base } = await fakeCompetitionApi(t, scriptedAgent);
  const tasksFile = path.join(out, "tasks.json");
  await mkdir(out, { recursive: true });
  await writeFile(
    tasksFile,
    `\uFEFF${JSON.stringify({ tasks: suite.tasks.slice(0, 2) })}`,
  );
  const cli = (args) =>
    new Promise((resolve) =>
      execFile(
        process.execPath,
        [script, ...args],
        { windowsHide: true },
        (error, stdout, stderr) =>
          resolve({ code: error ? error.code : 0, stdout, stderr }),
      ),
    );
  assert.equal((await cli([])).code, 2);
  assert.equal((await cli(["--help"])).code, 0);
  assert.equal(
    (
      await cli([
        "--base",
        base,
        "--out",
        out,
        "--tasks",
        path.join(out, "missing.json"),
      ])
    ).code,
    2,
  );
  const failing = await cli([
    "--base",
    base,
    "--out",
    out,
    "--tasks",
    tasksFile,
    "--engine",
    "cli run",
  ]);
  assert.equal(failing.code, 1, failing.stderr);
  assert.match(
    failing.stdout,
    /"event":"competition.task","task":"lazy_1","outcome":"FAIL"/,
  );
  assert.match(
    failing.stdout,
    /"event":"competition.tasks","label":"cli_run","totals":\{"PASS":1,"FAIL":1/,
  );
  const clean = await cli([
    "--base",
    base,
    "--out",
    out,
    "--tasks",
    tasksFile,
    "--only",
    "todo_1",
    "--require-survival",
  ]);
  assert.equal(clean.code, 0, clean.stderr);
});

test("a desktop-only task on a session without a shell is ENV, not FAIL", async () => {
  const withShell = await checkRequirement(
    { kind: "desktop_session" },
    {
      platform: "win32",
      run: async () => ({
        code: 0,
        stdout: Buffer.from(
          '"explorer.exe","4242","Console","1","50,000 K"\r\n',
        ),
        stderr: Buffer.alloc(0),
      }),
    },
  );
  assert.equal(withShell.satisfied, true);
  const serviceSession = await checkRequirement(
    { kind: "desktop_session" },
    {
      platform: "win32",
      run: async () => ({
        code: 0,
        stdout: Buffer.from('"svchost.exe","900","Services","0","5,000 K"\r\n'),
        stderr: Buffer.alloc(0),
      }),
    },
  );
  assert.equal(serviceSession.satisfied, false);
  assert.deepEqual(
    decideOutcome({
      httpStatus: 204,
      verifyOk: false,
      requirements: [serviceSession],
      honest: true,
    }).outcome,
    "ENV",
  );
  assert.deepEqual(
    decideOutcome({
      httpStatus: 204,
      verifyOk: false,
      requirements: [serviceSession],
      honest: false,
    }).outcome,
    "FAIL",
  );
});
