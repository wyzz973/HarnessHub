// office_read: docx / xlsx / pptx / pdf / text files -> text, Markdown or JSON.
import { readFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import mammoth from "mammoth";
import { decodeText, finish, inputFile, parse, ToolError } from "./common.mjs";

const usage = `
office_read <file> [--format text|json] [--sheet <name|index>] [--max-rows 500] [--max-chars 60000]
Reads .docx (headings, lists, tables as Markdown), .xlsx/.xlsm (every sheet as CSV; json adds
formulas), .pptx (slide titles, bullets, tables, notes), .pdf (text per page) and plain text
(.txt .md .csv .json .ics .eml ..., UTF-8/UTF-16/GBK detected). Prints {"ok":true,"kind":...,
"content":...}; long content is cut at --max-chars with "truncated":true.`;

function entities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");
}

/** Markdown for the small, well-formed HTML subset mammoth emits. */
export function htmlToMarkdown(html) {
  let out = "";
  const lists = [];
  let table;
  let cell;
  let href;
  const write = (text) => {
    if (cell !== undefined) cell += text;
    else out += text;
  };
  for (const part of html.split(/(<[^>]+>)/)) {
    if (!part) continue;
    if (!part.startsWith("<")) {
      write(entities(part));
      continue;
    }
    const match = /^<\s*(\/)?\s*([a-z0-9]+)([^>]*)>$/i.exec(part);
    if (!match) continue;
    const closing = Boolean(match[1]);
    const tag = match[2].toLowerCase();
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) write(closing ? "\n\n" : `\n\n${"#".repeat(Number(heading[1]))} `);
    else if (tag === "p") {
      if (closing) write(cell !== undefined ? " " : lists.length ? "\n" : "\n\n");
    } else if (tag === "br") write(cell !== undefined ? " " : "\n");
    else if (tag === "strong" || tag === "b") write("**");
    else if (tag === "em" || tag === "i") write("*");
    else if (tag === "a") {
      if (!closing) {
        href = /href="([^"]*)"/i.exec(match[3])?.[1];
        if (href && !href.startsWith("#")) write("[");
        else href = undefined;
      } else if (href) {
        write(`](${entities(href)})`);
        href = undefined;
      }
    } else if (tag === "img") write("[图片]");
    else if (tag === "ul" || tag === "ol") {
      if (closing) {
        lists.pop();
        if (!lists.length) write("\n");
      } else lists.push({ ordered: tag === "ol", index: 0 });
    } else if (tag === "li" && !closing) {
      const list = lists.at(-1) ?? { ordered: false, index: 0 };
      list.index++;
      if (!out.endsWith("\n")) write("\n");
      write(`${"  ".repeat(Math.max(0, lists.length - 1))}${list.ordered ? `${list.index}.` : "-"} `);
    } else if (tag === "table") {
      if (closing && table) {
        const width = Math.max(...table.map((row) => row.length), 1);
        const line = (row) =>
          `| ${Array.from({ length: width }, (_, index) => (row[index] ?? "").replace(/\s+/g, " ").replaceAll("|", "\\|").trim()).join(" | ")} |`;
        const rows = table;
        table = undefined;
        if (rows.length)
          out += `\n\n${line(rows[0])}\n| ${Array.from({ length: width }, () => "---").join(" | ")} |\n${rows.slice(1).map(line).join("\n")}\n\n`;
      } else if (!closing) table = [];
    } else if (tag === "tr" && !closing) table?.push([]);
    else if (tag === "td" || tag === "th") {
      if (closing) {
        table?.at(-1)?.push(cell ?? "");
        cell = undefined;
      } else cell = "";
    }
  }
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
  }
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((item) => item.text).join("");
    if ("result" in value) return cellText(value.result);
    if ("formula" in value || "sharedFormula" in value) return "";
    if ("text" in value) return cellText(value.text);
    if ("error" in value) return String(value.error);
    return JSON.stringify(value);
  }
  return String(value);
}

function csvField(text) {
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function readWorkbook(file, selector, maxRows, json) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(file);
  } catch (error) {
    throw new ToolError("UNREADABLE_WORKBOOK", `${file}: ${error.message}`);
  }
  const sheets = workbook.worksheets.filter(
    (sheet, index) =>
      selector === undefined ||
      sheet.name.toLowerCase() === selector.toLowerCase() ||
      String(index + 1) === selector,
  );
  if (!sheets.length)
    throw new ToolError(
      "UNKNOWN_SHEET",
      `Sheet "${selector}" not found; sheets: ${workbook.worksheets.map((sheet) => sheet.name).join(", ")}`,
    );
  const result = [];
  for (const sheet of sheets) {
    const rows = [];
    const formulas = {};
    let truncated = false;
    sheet.eachRow({ includeEmpty: false }, (row, number) => {
      if (rows.length >= maxRows) {
        truncated = true;
        return;
      }
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, column) => {
        cells[column - 1] = cellText(cell.value);
        const formula = cell.value?.formula ?? cell.value?.sharedFormula;
        if (json && formula) formulas[cell.address] = `=${formula}`;
      });
      rows.push({ number, cells: Array.from(cells, (item) => item ?? "") });
    });
    result.push({
      name: sheet.name,
      rowCount: sheet.actualRowCount,
      columnCount: sheet.actualColumnCount,
      ...(truncated ? { truncated: true } : {}),
      rows,
      formulas,
    });
  }
  return result;
}

function xmlText(xml) {
  const paragraphs = [];
  for (const paragraph of xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? []) {
    const level = Number(/<a:pPr[^>]*\blvl="(\d+)"/.exec(paragraph)?.[1] ?? 0);
    const text = entities(
      (paragraph.match(/<a:t(?:\s[^>]*)?>[\s\S]*?<\/a:t>|<a:br\s*\/?>/g) ?? [])
        .map((run) => (run.startsWith("<a:br") ? "\n" : run.replace(/<[^>]+>/g, "")))
        .join(""),
    ).trim();
    if (text) paragraphs.push({ level, text });
  }
  return paragraphs;
}

async function readPresentation(file) {
  const zip = await JSZip.loadAsync(await readFile(file)).catch((error) => {
    throw new ToolError("UNREADABLE_PRESENTATION", `${file}: ${error.message}`);
  });
  const text = async (name) => (await zip.file(name)?.async("string")) ?? "";
  const presentation = await text("ppt/presentation.xml");
  const relations = await text("ppt/_rels/presentation.xml.rels");
  const targets = new Map(
    [...relations.matchAll(/<Relationship\b[^>]*>/g)].map((match) => [
      /\bId="([^"]+)"/.exec(match[0])?.[1],
      /\bTarget="([^"]+)"/.exec(match[0])?.[1],
    ]),
  );
  const order = [...presentation.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)]
    .map((match) => targets.get(match[1]))
    .filter(Boolean)
    .map((target) => path.posix.normalize(`ppt/${target.replace(/^\//, "../")}`));
  const slides = [];
  for (const [index, name] of order.entries()) {
    const xml = await text(name);
    let title;
    const body = [];
    const tables = [];
    for (const shape of xml.match(/<p:sp\b[\s\S]*?<\/p:sp>/g) ?? []) {
      const paragraphs = xmlText(shape);
      if (!paragraphs.length) continue;
      if (/<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(shape) && title === undefined)
        title = paragraphs.map((item) => item.text).join(" ");
      else body.push(...paragraphs);
    }
    for (const table of xml.match(/<a:tbl\b[\s\S]*?<\/a:tbl>/g) ?? [])
      tables.push(
        (table.match(/<a:tr\b[\s\S]*?<\/a:tr>/g) ?? []).map((row) =>
          (row.match(/<a:tc\b[\s\S]*?<\/a:tc>/g) ?? []).map((item) =>
            xmlText(item)
              .map((paragraph) => paragraph.text)
              .join(" "),
          ),
        ),
      );
    // Writers without layout placeholders (pptxgenjs): the first text box is the title.
    if (title === undefined && body.length) title = body.shift().text;
    while (body.length && /^\d{1,3}$/.test(body.at(-1).text)) body.pop();
    const rels = await text(name.replace(/slides\/(slide\d+\.xml)$/, "slides/_rels/$1.rels"));
    const noteTarget = /Target="([^"]*notesSlide\d+\.xml)"/.exec(rels)?.[1];
    const notes = noteTarget
      ? xmlText(await text(path.posix.normalize(`ppt/slides/${noteTarget}`)))
          .map((item) => item.text)
          .filter((item) => !/^\d+$/.test(item))
          .join("\n")
      : "";
    slides.push({ index: index + 1, title: title ?? "", body, tables, ...(notes ? { notes } : {}) });
  }
  return slides;
}

/** Text rendering of a supported file: {kind, content, data?, ...counts}. */
export async function officeText(file, { sheet, maxRows = 500, json = false } = {}) {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".docx" || extension === ".docm") {
    const converted = await mammoth
      .convertToHtml(
        { path: file },
        { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })) },
      )
      .catch((error) => {
        throw new ToolError("UNREADABLE_DOCUMENT", `${file}: ${error.message}`);
      });
    return { kind: "word", content: htmlToMarkdown(converted.value) };
  }
  if (extension === ".xlsx" || extension === ".xlsm") {
    const sheets = await readWorkbook(file, sheet, maxRows, json);
    return {
      kind: "excel",
      sheets: sheets.map(({ name, rowCount, columnCount, truncated }) => ({ name, rowCount, columnCount, ...(truncated ? { truncated } : {}) })),
      ...(json ? { data: sheets.map((item) => ({ name: item.name, rows: item.rows.map((row) => row.cells), formulas: item.formulas })) } : {}),
      content: sheets
        .map((item) => `## ${item.name} (${item.rowCount} 行 × ${item.columnCount} 列)\n${item.rows.map((row) => row.cells.map(csvField).join(",")).join("\n")}`)
        .join("\n\n"),
    };
  }
  if (extension === ".pptx" || extension === ".ppsx") {
    const slides = await readPresentation(file);
    return {
      kind: "powerpoint",
      slides: slides.length,
      ...(json ? { data: slides } : {}),
      content: slides
        .map((slide) =>
          [
            `## 第 ${slide.index} 页 ${slide.title}`.trim(),
            ...slide.body.map((item) => `${"  ".repeat(item.level)}- ${item.text}`),
            ...slide.tables.map((table) => table.map((row) => `| ${row.join(" | ")} |`).join("\n")),
            ...(slide.notes ? [`> 备注: ${slide.notes}`] : []),
          ].join("\n"),
        )
        .join("\n\n"),
    };
  }
  if (extension === ".pdf") {
    const { extractText } = await import("unpdf");
    const pages = await extractText(new Uint8Array(await readFile(file)), { mergePages: false }).catch((error) => {
      throw new ToolError("UNREADABLE_PDF", `${file}: ${error.message}`);
    });
    return {
      kind: "pdf",
      pages: pages.totalPages,
      ...(pages.text.some((page) => page.trim()) ? {} : { note: "No text layer found (scanned PDF); OCR is not available offline." }),
      content: pages.text.map((page, index) => `## 第 ${index + 1} 页\n${page.trim()}`).join("\n\n"),
    };
  }
  if ([".doc", ".xls", ".ppt", ".rtf", ".wps", ".et", ".dps"].includes(extension))
    throw new ToolError(
      "LEGACY_FORMAT",
      `${extension} is a legacy binary format`,
      "Convert it with the installed Office first (references: SaveAs through COM), then read the converted file.",
    );
  const bytes = await readFile(file);
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  if (!utf16 && bytes.subarray(0, 8000).includes(0))
    throw new ToolError("BINARY_FILE", `${file} looks like a binary file that this tool cannot read`);
  return { kind: "text", content: decodeText(bytes) };
}

export async function officeRead(argv) {
  const { values, positionals } = parse(
    argv,
    {
      format: { type: "string", default: "text" },
      sheet: { type: "string" },
      "max-rows": { type: "string", default: "500" },
      "max-chars": { type: "string", default: "60000" },
      input: { type: "string" },
    },
    usage,
    { positionals: true },
  );
  const target = positionals[0] ?? values.input;
  if (!target) throw new ToolError("USAGE", "A file path is required", usage.trim());
  if (!["text", "json"].includes(values.format)) throw new ToolError("USAGE", "--format must be text or json");
  const file = await inputFile(target);
  const maxChars = Math.min(200000, Math.max(200, Number(values["max-chars"]) || 60000));
  const { content, data, ...rest } = await officeText(file, {
    sheet: values.sheet,
    maxRows: Math.max(1, Number(values["max-rows"]) || 500),
    json: values.format === "json",
  });
  const truncated = content.length > maxChars;
  finish({
    file,
    ...rest,
    chars: content.length,
    ...(truncated ? { truncated: true } : {}),
    content: truncated ? content.slice(0, maxChars) : content,
    ...(data && !truncated ? { data } : {}),
  });
}
