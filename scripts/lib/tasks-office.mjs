/**
 * Dependency-free OOXML (docx / xlsx / pptx) inspection and minimal fixture builders for
 * the competition task suite. Reading is tolerant text extraction from the XML parts, not
 * a rendering engine: it answers "does this file open as a package, does it have the
 * mandatory parts, and which text, cells and formulas does it contain".
 *
 * The builders write the smallest packages Word, Excel and PowerPoint accept; they give
 * tasks realistic input files (for example a docx the agent must read) and give the
 * tests fixtures without binary files in the repository.
 */
import { readZip, writeZip } from "./tasks-zip.mjs";

function officeError(message) {
  return Object.assign(new Error(message), { code: "INVALID_OFFICE_FILE" });
}

/** Decode the five predefined XML entities and numeric character references. */
export function decodeXml(text) {
  return text.replace(
    /&(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g,
    (_match, name) => {
      if (name === "amp") return "&";
      if (name === "lt") return "<";
      if (name === "gt") return ">";
      if (name === "quot") return '"';
      if (name === "apos") return "'";
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    },
  );
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Office format from a file name, or undefined. */
export function officeFormat(file) {
  const match = /\.(docx|docm|xlsx|xlsm|pptx|pptm)$/i.exec(file);
  if (!match) return undefined;
  const extension = match[1].toLowerCase();
  if (extension.startsWith("doc")) return "docx";
  if (extension.startsWith("xls")) return "xlsx";
  return "pptx";
}

function part(zip, name) {
  return zip.read(name).toString("utf8");
}

function requireParts(zip, names, format) {
  const missing = names.filter((name) => !zip.has(name));
  if (missing.length)
    throw officeError(
      `${format} package is missing mandatory part(s): ${missing.join(", ")}`,
    );
}

/** Text of WordprocessingML or DrawingML runs inside one paragraph-like element. */
function runsText(xml, textTag, tabTag, breakTag) {
  const pattern = new RegExp(
    `<${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${textTag}>|<${tabTag}(?:\\s[^>]*)?/>|<${breakTag}(?:\\s[^>]*)?/>`,
    "g",
  );
  let text = "";
  for (const match of xml.matchAll(pattern))
    if (match[1] !== undefined) text += decodeXml(match[1]);
    else if (match[0].startsWith(`<${tabTag}`)) text += "\t";
    else text += "\n";
  return text;
}

function paragraphs(xml, paragraphTag, textTag, tabTag, breakTag) {
  const pattern = new RegExp(
    `<${paragraphTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${paragraphTag}>`,
    "g",
  );
  const lines = [];
  for (const match of xml.matchAll(pattern)) {
    const text = runsText(match[1], textTag, tabTag, breakTag);
    if (text.trim()) lines.push(text);
  }
  return lines;
}

function readDocx(zip) {
  requireParts(zip, ["[Content_Types].xml", "word/document.xml"], "docx");
  const document = part(zip, "word/document.xml");
  const lines = paragraphs(document, "w:p", "w:t", "w:tab", "w:br");
  for (const entry of zip.entries)
    if (/^word\/(?:header|footer|footnotes|endnotes)\d*\.xml$/.test(entry.name))
      lines.push(
        ...paragraphs(part(zip, entry.name), "w:p", "w:t", "w:tab", "w:br"),
      );
  return {
    format: "docx",
    text: lines.join("\n"),
    paragraphs: lines.length,
    tables: (document.match(/<w:tbl[\s>]/g) ?? []).length,
    images: zip.entries.filter((entry) => /^word\/media\//.test(entry.name))
      .length,
  };
}

function readPptx(zip) {
  requireParts(zip, ["[Content_Types].xml", "ppt/presentation.xml"], "pptx");
  const slides = zip.entries
    .map((entry) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(entry.name))
    .filter(Boolean)
    .map((match) => ({ name: match[0], number: Number(match[1]) }))
    .sort((a, b) => a.number - b.number)
    .map((slide) =>
      paragraphs(part(zip, slide.name), "a:p", "a:t", "a:tab", "a:br").join(
        "\n",
      ),
    );
  return {
    format: "pptx",
    text: slides.join("\n\n"),
    slides: slides.length,
    slideTexts: slides,
  };
}

function attribute(tag, name) {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? decodeXml(match[1]) : undefined;
}

function readXlsx(zip) {
  requireParts(zip, ["[Content_Types].xml", "xl/workbook.xml"], "xlsx");
  const shared = [];
  if (zip.has("xl/sharedStrings.xml"))
    for (const match of part(zip, "xl/sharedStrings.xml").matchAll(
      /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g,
    ))
      shared.push(
        match[1] === undefined
          ? ""
          : [...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
              .map((run) => decodeXml(run[1]))
              .join(""),
      );
  const targets = new Map();
  if (zip.has("xl/_rels/workbook.xml.rels"))
    for (const match of part(zip, "xl/_rels/workbook.xml.rels").matchAll(
      /<Relationship\s[^>]*>/g,
    )) {
      const id = attribute(match[0], "Id");
      const target = attribute(match[0], "Target");
      if (id && target)
        targets.set(
          id,
          target.startsWith("/")
            ? target.slice(1)
            : `xl/${target}`.replace(/\/\.\//g, "/"),
        );
    }
  const sheets = [];
  const workbook = part(zip, "xl/workbook.xml");
  let position = 0;
  for (const match of workbook.matchAll(/<sheet\s[^>]*>/g)) {
    position++;
    const name = attribute(match[0], "name") ?? `Sheet${position}`;
    const relation = attribute(match[0], "r:id");
    const target =
      (relation && targets.get(relation)) ??
      `xl/worksheets/sheet${position}.xml`;
    if (!zip.has(target)) continue;
    const cells = new Map();
    const xml = part(zip, target);
    for (const cell of xml.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const reference = attribute(` ${cell[1]}`, "r");
      if (!reference) continue;
      const type = attribute(` ${cell[1]}`, "t") ?? "n";
      const body = cell[2] ?? "";
      const formulaMatch =
        /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>|<f(?:\s[^>]*)?\/>/.exec(body);
      const raw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value;
      if (type === "s")
        value = raw === undefined ? undefined : shared[Number(raw)];
      else if (type === "inlineStr")
        value = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
          .map((run) => decodeXml(run[1]))
          .join("");
      else if (type === "b")
        value = raw === undefined ? undefined : raw === "1";
      else if (type === "str" || type === "e")
        value = raw === undefined ? undefined : decodeXml(raw);
      else value = raw === undefined || raw === "" ? undefined : Number(raw);
      cells.set(reference.toUpperCase(), {
        value,
        ...(formulaMatch ? { formula: decodeXml(formulaMatch[1] ?? "") } : {}),
      });
    }
    sheets.push({ name, cells });
  }
  if (!sheets.length) throw officeError("xlsx workbook has no readable sheet");
  const lines = [];
  for (const sheet of sheets) {
    const rows = new Map();
    for (const [reference, cell] of sheet.cells) {
      const row = Number(/\d+$/.exec(reference)?.[0] ?? 0);
      if (!rows.has(row)) rows.set(row, []);
      if (cell.value !== undefined && cell.value !== "")
        rows.get(row).push(String(cell.value));
    }
    for (const row of [...rows.keys()].sort((a, b) => a - b))
      if (rows.get(row).length) lines.push(rows.get(row).join("\t"));
  }
  return { format: "xlsx", text: lines.join("\n"), sheets };
}

/**
 * Inspect an Office Open XML file held in memory.
 *
 * @param {Buffer} buffer File bytes.
 * @param {"docx"|"xlsx"|"pptx"} format Expected package type.
 * @returns docx: `{format,text,paragraphs,tables,images}`; pptx:
 *   `{format,text,slides,slideTexts}`; xlsx: `{format,text,sheets:[{name,cells}]}` where
 *   `cells` maps `A1` references to `{value, formula?}`.
 * @throws {Error} `INVALID_ZIP` when the file is not a readable ZIP and
 *   `INVALID_OFFICE_FILE` when mandatory parts are missing.
 */
export function readOffice(buffer, format) {
  const zip = readZip(buffer);
  if (format === "docx") return readDocx(zip);
  if (format === "xlsx") return readXlsx(zip);
  if (format === "pptx") return readPptx(zip);
  throw officeError(`Unsupported Office format: ${format}`);
}

const CONTENT_TYPES_HEAD =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>';
const rootRelationships = (target, type) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/></Relationships>`;

/**
 * Minimal Word document: paragraphs (a string, or `{text, heading: 1..3}`) and an
 * optional table (rows of cell strings) appended after them.
 */
export function buildDocx({ paragraphs: items = [], table } = {}) {
  const paragraph = (item) => {
    const text = typeof item === "string" ? item : item.text;
    const heading = typeof item === "string" ? undefined : item.heading;
    const properties = heading
      ? `<w:pPr><w:outlineLvl w:val="${heading - 1}"/></w:pPr>`
      : "";
    const run = heading
      ? `<w:r><w:rPr><w:b/><w:sz w:val="${36 - heading * 4}"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
      : `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
    return `<w:p>${properties}${run}</w:p>`;
  };
  const tableXml = table
    ? `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr>${table
        .map(
          (row) =>
            `<w:tr>${row
              .map(
                (cell) =>
                  `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${paragraph(String(cell))}</w:tc>`,
              )
              .join("")}</w:tr>`,
        )
        .join("")}</w:tbl>`
    : "";
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${items.map(paragraph).join("")}${tableXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return writeZip([
    {
      name: "[Content_Types].xml",
      data: `${CONTENT_TYPES_HEAD}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: rootRelationships("word/document.xml", "officeDocument"),
    },
    { name: "word/document.xml", data: document },
  ]);
}

function columnName(index) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
}

/**
 * Minimal workbook. `sheets` is `[{name, rows}]`; a cell is a string (inline string), a
 * number, a boolean, null (empty) or `{formula, value?}`.
 */
export function buildXlsx({ sheets = [] } = {}) {
  if (!sheets.length) throw officeError("buildXlsx needs at least one sheet");
  const sheetXml = (rows) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
      .map((row, rowIndex) => {
        const cells = row
          .map((cell, columnIndex) => {
            const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
            if (cell === null || cell === undefined || cell === "") return "";
            if (typeof cell === "number")
              return `<c r="${reference}"><v>${cell}</v></c>`;
            if (typeof cell === "boolean")
              return `<c r="${reference}" t="b"><v>${cell ? 1 : 0}</v></c>`;
            if (typeof cell === "object")
              return `<c r="${reference}"><f>${escapeXml(cell.formula)}</f>${cell.value === undefined ? "" : `<v>${escapeXml(cell.value)}</v>`}</c>`;
            return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
          })
          .join("");
        return `<row r="${rowIndex + 1}">${cells}</row>`;
      })
      .join("")}</sheetData></worksheet>`;
  return writeZip([
    {
      name: "[Content_Types].xml",
      data: `${CONTENT_TYPES_HEAD}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
        .map(
          (_sheet, index) =>
            `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join("")}</Types>`,
    },
    {
      name: "_rels/.rels",
      data: rootRelationships("xl/workbook.xml", "officeDocument"),
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
        .map(
          (sheet, index) =>
            `<sheet name="${escapeXml(sheet.name ?? `Sheet${index + 1}`)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
        )
        .join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map(
          (_sheet, index) =>
            `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
        )
        .join("")}</Relationships>`,
    },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: sheetXml(sheet.rows ?? []),
    })),
  ]);
}

/**
 * Text-only presentation parts for reader tests: slide XML with a title and bullets.
 * It has no slide master or layout, so it is NOT meant to be opened in PowerPoint and is
 * never handed to an agent as task input.
 */
export function buildPptxFixture({ slides = [] } = {}) {
  const slideXml = (slide) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${escapeXml(slide.title ?? "")}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody>${(
      slide.bullets ?? []
    )
      .map((bullet) => `<a:p><a:r><a:t>${escapeXml(bullet)}</a:t></a:r></a:p>`)
      .join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  return writeZip([
    {
      name: "[Content_Types].xml",
      data: `${CONTENT_TYPES_HEAD}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: rootRelationships("ppt/presentation.xml", "officeDocument"),
    },
    {
      name: "ppt/presentation.xml",
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
    },
    ...slides.map((slide, index) => ({
      name: `ppt/slides/slide${index + 1}.xml`,
      data: slideXml(slide),
    })),
  ]);
}
