// docx_create: Markdown (or plain text) -> Word document.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  PageBreak,
  PageNumber,
  PageOrientation,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { finish, inputFile, outputFile, parse, readText, ToolError } from "./common.mjs";
import { blocks, imageSize, plain, runs } from "./markdown.mjs";

const usage = `
docx_create --output <file.docx> (--input <file.md|.txt> | --content "<markdown>")
  [--title 文档标题] [--author 作者] [--font 微软雅黑] [--font-size 11] [--landscape]
  [--header 页眉文字] [--page-numbers] [--toc] [--plain]
Markdown: # 标题, 段落, **粗体** *斜体* \`代码\` ~~删除~~ [链接](url), - / 1. 列表(可嵌套, [ ] 任务),
| 表格 |, > 引用, \`\`\`代码块\`\`\`, ---, ![图](本地图片.png), 单独一行 \\pagebreak 分页。
Writes the .docx and prints {"ok":true,"output":...}.`;

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];
const ALIGN = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
};
const PAGE = { width: 11906, height: 16838, margin: 1440 };

function displayWidth(text) {
  let width = 0;
  for (const char of text) width += /[\u2e80-\uffef]/.test(char) ? 2 : 1;
  return width;
}

export async function docxCreate(argv) {
  const { values } = parse(
    argv,
    {
      input: { type: "string" },
      content: { type: "string" },
      output: { type: "string" },
      title: { type: "string" },
      author: { type: "string" },
      font: { type: "string" },
      "font-size": { type: "string" },
      landscape: { type: "boolean", default: false },
      header: { type: "string" },
      "page-numbers": { type: "boolean", default: false },
      toc: { type: "boolean", default: false },
      plain: { type: "boolean", default: false },
    },
    usage,
  );
  if (!values.output) throw new ToolError("USAGE", "--output is required", usage.trim());
  if (!values.input === !values.content)
    throw new ToolError(
      "USAGE",
      "Pass exactly one of --input <file> or --content <markdown>",
      usage.trim(),
    );
  const source = values.input ? await inputFile(values.input) : undefined;
  const baseDirectory = source ? path.dirname(source) : process.cwd();
  const text = source ? await readText(source) : values.content;
  const output = await outputFile(values.output, ".docx");
  const size = Math.round(Number(values["font-size"] ?? 11) * 2);
  if (!Number.isFinite(size) || size < 12 || size > 96)
    throw new ToolError("USAGE", "--font-size must be between 6 and 48 (points)");
  const eastAsia = values.font ?? "微软雅黑";
  const latin = values.font ?? "Calibri";
  const font = { ascii: latin, hAnsi: latin, eastAsia, cs: latin };
  const usable =
    (values.landscape ? PAGE.height : PAGE.width) - 2 * PAGE.margin;
  const stats = { paragraphs: 0, headings: 0, tables: 0, lists: 0, images: 0 };
  const warnings = [];
  let orderedLists = 0;
  let firstHeading;

  async function inline(tokens, base = {}) {
    const children = [];
    for (const run of runs(tokens)) {
      if (run.image) {
        const image = await picture(run.image);
        if (image) children.push(image);
        else children.push(new TextRun({ text: `[图片缺失: ${run.image.href}]`, ...base }));
        continue;
      }
      const options = {
        text: run.text,
        bold: run.bold || base.bold,
        italics: run.italic || base.italics,
        strike: run.strike,
        ...(base.color ? { color: base.color } : {}),
        ...(base.size ? { size: base.size } : {}),
        ...(run.break ? { break: 1 } : {}),
        ...(run.code
          ? {
              font: { ascii: "Consolas", hAnsi: "Consolas", eastAsia, cs: "Consolas" },
              shading: { type: ShadingType.CLEAR, fill: "F2F2F2", color: "auto" },
            }
          : {}),
      };
      if (run.link && /^(https?:|mailto:|file:)/i.test(run.link))
        children.push(
          new ExternalHyperlink({
            link: run.link,
            children: [new TextRun({ ...options, style: "Hyperlink" })],
          }),
        );
      else children.push(new TextRun(options));
    }
    return children;
  }

  async function picture(image) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(image.href) && !/^file:/i.test(image.href)) {
      warnings.push(`Remote image skipped (offline): ${image.href}`);
      return undefined;
    }
    const file = path.resolve(
      baseDirectory,
      decodeURIComponent(image.href.replace(/^file:\/\//i, "")),
    );
    let bytes;
    try {
      bytes = await readFile(file);
    } catch {
      warnings.push(`Image not found: ${file}`);
      return undefined;
    }
    const info = imageSize(bytes);
    if (!info) {
      warnings.push(`Unsupported image type (use PNG, JPEG, GIF or BMP): ${file}`);
      return undefined;
    }
    const limit = Math.floor((usable / 1440) * 96);
    const scale = Math.min(1, limit / info.width);
    stats.images++;
    return new ImageRun({
      type: info.type,
      data: bytes,
      transformation: {
        width: Math.max(1, Math.round(info.width * scale)),
        height: Math.max(1, Math.round(info.height * scale)),
      },
      altText: { title: image.alt || "image", description: image.alt || "image", name: image.alt || "image" },
    });
  }

  async function list(token, level, children) {
    stats.lists += level === 0 ? 1 : 0;
    const instance = token.ordered ? ++orderedLists : undefined;
    const depth = Math.min(level, 3);
    for (const item of token.items) {
      let first = true;
      for (const part of item.tokens) {
        if (part.type === "list") {
          await list(part, level + 1, children);
          continue;
        }
        if (part.type === "space" || part.type === "checkbox") continue;
        const content = await inline(part.tokens ?? [{ type: "text", text: part.text ?? part.raw }]);
        if (item.task && first)
          content.unshift(new TextRun({ text: item.checked ? "☑ " : "☐ " }));
        children.push(
          new Paragraph({
            children: content,
            spacing: { after: 60 },
            ...(first
              ? {
                  numbering: {
                    reference: token.ordered ? "hh-numbers" : "hh-bullets",
                    level: depth,
                    ...(instance ? { instance } : {}),
                  },
                }
              : { indent: { left: 720 * (depth + 1) } }),
          }),
        );
        stats.paragraphs++;
        first = false;
      }
    }
  }

  function table(token, cellsOf) {
    const columns = token.header.length;
    const weights = Array.from({ length: columns }, (_, column) =>
      Math.min(
        40,
        Math.max(
          6,
          ...[token.header, ...token.rows].map((row) =>
            displayWidth(plain(row[column]?.tokens ?? [])),
          ),
        ),
      ),
    );
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const widths = weights.map((weight) => Math.floor((usable * weight) / total));
    const border = { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" };
    const row = (cells, header) =>
      new TableRow({
        tableHeader: header,
        cantSplit: true,
        children: cells.map(
          (cell, column) =>
            new TableCell({
              width: { size: widths[column], type: WidthType.DXA },
              margins: { top: 60, bottom: 60, left: 100, right: 100 },
              ...(header
                ? { shading: { type: ShadingType.CLEAR, fill: "DEEAF6", color: "auto" } }
                : {}),
              children: [
                new Paragraph({
                  alignment: ALIGN[token.align[column]] ?? AlignmentType.LEFT,
                  spacing: { after: 0 },
                  children: cellsOf.get(cell),
                }),
              ],
            }),
        ),
      });
    stats.tables++;
    return new Table({
      width: { size: usable, type: WidthType.DXA },
      columnWidths: widths,
      borders: {
        top: border,
        bottom: border,
        left: border,
        right: border,
        insideHorizontal: border,
        insideVertical: border,
      },
      rows: [row(token.header, true), ...token.rows.map((cells) => row(cells, false))],
    });
  }

  async function block(token, children, quote = false) {
    switch (token.type) {
      case "heading": {
        const title = plain(token.tokens);
        firstHeading ??= title;
        children.push(
          new Paragraph({
            heading: HEADINGS[token.depth - 1],
            children: await inline(token.tokens),
          }),
        );
        stats.headings++;
        break;
      }
      case "paragraph":
      case "text": {
        const raw = (token.text ?? "").trim();
        if (/^(\\pagebreak|\\newpage|\[\[pagebreak\]\])$/i.test(raw)) {
          children.push(new Paragraph({ children: [new PageBreak()] }));
          break;
        }
        children.push(
          new Paragraph({
            children: await inline(
              token.tokens ?? [{ type: "text", text: token.text }],
              quote ? { italics: true, color: "595959" } : {},
            ),
            ...(quote
              ? {
                  indent: { left: 480 },
                  border: {
                    left: { style: BorderStyle.SINGLE, size: 12, color: "A6A6A6", space: 8 },
                  },
                }
              : {}),
          }),
        );
        stats.paragraphs++;
        break;
      }
      case "list":
        await list(token, 0, children);
        break;
      case "table": {
        const cellsOf = new Map();
        for (const row of [token.header, ...token.rows])
          for (const cell of row)
            cellsOf.set(
              cell,
              await inline(cell.tokens, row === token.header ? { bold: true } : {}),
            );
        children.push(table(token, cellsOf));
        children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
        break;
      }
      case "code": {
        const lines = token.text.split("\n");
        children.push(
          new Paragraph({
            spacing: { before: 60, after: 160, line: 280 },
            shading: { type: ShadingType.CLEAR, fill: "F5F5F5", color: "auto" },
            children: lines.map(
              (line, index) =>
                new TextRun({
                  text: line,
                  size: Math.max(16, size - 2),
                  font: { ascii: "Consolas", hAnsi: "Consolas", eastAsia, cs: "Consolas" },
                  ...(index ? { break: 1 } : {}),
                }),
            ),
          }),
        );
        stats.paragraphs++;
        break;
      }
      case "blockquote":
        for (const inner of token.tokens) await block(inner, children, true);
        break;
      case "hr":
        children.push(
          new Paragraph({
            spacing: { before: 120, after: 120 },
            border: {
              bottom: { style: BorderStyle.SINGLE, size: 6, color: "BFBFBF", space: 1 },
            },
            children: [],
          }),
        );
        break;
      case "html":
        if (/<!--\s*pagebreak\s*-->/i.test(token.raw))
          children.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      default:
        break;
    }
  }

  const children = [];
  const isPlain = values.plain || (source && /\.txt$/i.test(source) && !/^#{1,6}\s/m.test(text));
  if (isPlain) {
    for (const part of text.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
      const lines = part.split("\n");
      children.push(
        new Paragraph({
          children: lines.map(
            (line, index) => new TextRun({ text: line, ...(index ? { break: 1 } : {}) }),
          ),
        }),
      );
      stats.paragraphs++;
    }
  } else for (const token of blocks(text)) await block(token, children);

  if (!children.length)
    throw new ToolError("EMPTY_DOCUMENT", "The input has no content to write");
  const title = values.title ?? firstHeading ?? path.basename(output, ".docx");
  const front = [];
  if (values.title)
    front.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: values.title })],
      }),
    );
  if (values.toc)
    front.push(
      new TableOfContents("目录", { hyperlink: true, headingStyleRange: "1-3" }),
      new Paragraph({ children: [new PageBreak()] }),
    );

  const headingRun = (points, extra = {}) => ({
    run: { size: points * 2, bold: true, font, color: "1F2937", ...extra },
    paragraph: { spacing: { before: 280, after: 140 }, keepNext: true },
  });
  const levels = (format, texts) =>
    texts.map((symbol, level) => ({
      level,
      format,
      text: symbol,
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
    }));
  const document = new Document({
    creator: values.author ?? "HarnessHub",
    lastModifiedBy: values.author ?? "HarnessHub",
    title,
    description: title,
    ...(values.toc ? { features: { updateFields: true } } : {}),
    styles: {
      default: {
        document: {
          run: { font, size },
          paragraph: { spacing: { after: 140, line: 340 } },
        },
        title: {
          run: { size: 44, bold: true, font, color: "111827" },
          paragraph: { spacing: { before: 120, after: 320 }, alignment: AlignmentType.CENTER },
        },
        heading1: headingRun(18),
        heading2: headingRun(15),
        heading3: headingRun(13),
        heading4: headingRun(12),
        heading5: headingRun(11),
        heading6: headingRun(11, { italics: true }),
      },
    },
    numbering: {
      config: [
        { reference: "hh-bullets", levels: levels(LevelFormat.BULLET, ["•", "◦", "▪", "•"]) },
        {
          reference: "hh-numbers",
          levels: levels(LevelFormat.DECIMAL, ["%1.", "%2)", "(%3)", "%4."]),
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: PAGE.width,
              height: PAGE.height,
              orientation: values.landscape
                ? PageOrientation.LANDSCAPE
                : PageOrientation.PORTRAIT,
            },
            margin: {
              top: PAGE.margin,
              bottom: PAGE.margin,
              left: PAGE.margin,
              right: PAGE.margin,
            },
          },
        },
        ...(values.header
          ? {
              headers: {
                default: new Header({
                  children: [
                    new Paragraph({
                      alignment: AlignmentType.RIGHT,
                      children: [new TextRun({ text: values.header, size: 18, color: "6B7280" })],
                    }),
                  ],
                }),
              },
            }
          : {}),
        ...(values["page-numbers"]
          ? {
              footers: {
                default: new Footer({
                  children: [
                    new Paragraph({
                      alignment: AlignmentType.CENTER,
                      children: [
                        new TextRun({
                          size: 18,
                          color: "6B7280",
                          children: [PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES],
                        }),
                      ],
                    }),
                  ],
                }),
              },
            }
          : {}),
        children: [...front, ...children],
      },
    ],
  });
  const bytes = await Packer.toBuffer(document);
  await writeFile(output, bytes);
  finish({ output, bytes: bytes.length, title, ...stats, ...(warnings.length ? { warnings } : {}) });
}
