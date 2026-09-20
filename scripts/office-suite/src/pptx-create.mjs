// pptx_create: Markdown outline -> PowerPoint presentation.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import PptxGenJS from "pptxgenjs";
import { finish, inputFile, outputFile, parse, readText, ToolError } from "./common.mjs";
import { blocks, imageSize, plain, runs } from "./markdown.mjs";

const usage = `
pptx_create --output <file.pptx> (--input <outline.md> | --content "<markdown>")
  [--theme blue|light|dark|green] [--ratio 16:9|4:3] [--author 作者] [--footer 页脚文字]
  [--no-page-numbers]
Outline: "# 标题" = 封面(其后的段落为副标题) 或章节页; "## 标题" = 新的一页; 列表 = 要点(可嵌套);
段落 = 正文; "### 小标题"; | 表格 |; ![图](本地图片.png); "> 备注" = 演讲者备注; "---" = 强制换页;
\`\`\`chart 代码块: type: bar|column|line|pie|doughnut|area / title: 标题 / labels: A,B,C /
series 销售额: 1,2,3 (可多行 series)。
Writes the .pptx and prints {"ok":true,"output":...,"slides":N}.`;

const THEMES = {
  blue: { cover: "1F3864", coverText: "FFFFFF", background: "FFFFFF", title: "1F3864", text: "333F50", accent: "2E75B6", muted: "7F8FA6", band: "DEEAF6" },
  light: { cover: "FFFFFF", coverText: "111827", background: "FFFFFF", title: "111827", text: "374151", accent: "2563EB", muted: "9CA3AF", band: "EFF6FF" },
  dark: { cover: "0B1220", coverText: "F9FAFB", background: "111827", title: "F9FAFB", text: "D1D5DB", accent: "38BDF8", muted: "6B7280", band: "1F2937" },
  green: { cover: "14532D", coverText: "FFFFFF", background: "FFFFFF", title: "14532D", text: "374151", accent: "16A34A", muted: "86A08F", band: "DCFCE7" },
};
const FONT = "微软雅黑";
const CHARTS = { bar: "bar", column: "bar", line: "line", pie: "pie", doughnut: "doughnut", area: "area" };

function chartSpec(text) {
  const spec = { type: "column", labels: [], series: [] };
  for (const line of text.split("\n")) {
    const match = /^\s*([^:：]+)[:：]\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (/^type$/i.test(key)) spec.type = value.toLowerCase();
    else if (/^title$/i.test(key)) spec.title = value;
    else if (/^labels?$/i.test(key)) spec.labels = value.split(/[,，]/).map((item) => item.trim());
    else if (/^series\b/i.test(key))
      spec.series.push({
        name: key.replace(/^series\s*/i, "").trim() || `系列${spec.series.length + 1}`,
        values: value.split(/[,，]/).map((item) => Number(item.trim())),
      });
  }
  if (!CHARTS[spec.type]) throw new ToolError("BAD_CHART", `Unknown chart type: ${spec.type}`);
  if (!spec.labels.length || !spec.series.length || spec.series.some((series) => series.values.some(Number.isNaN)))
    throw new ToolError("BAD_CHART", "A chart needs labels and at least one numeric series", usage.trim());
  return spec;
}

/** Split the outline into slides: {kind, title, items:[...], notes:[]}. */
function outline(tokens) {
  const slides = [];
  let current;
  const open = (kind, title) => {
    current = { kind, title, items: [], notes: [] };
    slides.push(current);
    return current;
  };
  for (const token of tokens) {
    if (token.type === "space") continue;
    if (token.type === "heading" && token.depth === 1) {
      open(slides.length ? "section" : "cover", plain(token.tokens));
      continue;
    }
    if (token.type === "heading" && token.depth === 2) {
      open("content", plain(token.tokens));
      continue;
    }
    if (token.type === "hr") {
      open("content", current?.kind === "content" ? current.title : undefined);
      continue;
    }
    current ??= open("content", undefined);
    if (token.type === "blockquote") current.notes.push(plain(token.tokens.flatMap((inner) => inner.tokens ?? [])));
    else if (token.type === "heading") current.items.push({ type: "subheading", tokens: token.tokens });
    else if (token.type === "paragraph" || token.type === "text") {
      const only = token.tokens?.length === 1 && token.tokens[0].type === "image" ? token.tokens[0] : undefined;
      if (only) current.items.push({ type: "image", href: only.href, alt: only.text });
      else current.items.push({ type: "paragraph", tokens: token.tokens ?? [{ type: "text", text: token.text }] });
    } else if (token.type === "list") current.items.push({ type: "list", token });
    else if (token.type === "table") current.items.push({ type: "table", token });
    else if (token.type === "code")
      current.items.push(
        /^chart$/i.test(token.lang ?? "")
          ? { type: "chart", spec: chartSpec(token.text) }
          : { type: "code", text: token.text },
      );
  }
  return slides;
}

export async function pptxCreate(argv) {
  const { values } = parse(
    argv,
    {
      input: { type: "string" },
      content: { type: "string" },
      output: { type: "string" },
      theme: { type: "string", default: "blue" },
      ratio: { type: "string", default: "16:9" },
      author: { type: "string" },
      footer: { type: "string" },
      "no-page-numbers": { type: "boolean", default: false },
    },
    usage,
  );
  if (!values.output) throw new ToolError("USAGE", "--output is required", usage.trim());
  if (!values.input === !values.content)
    throw new ToolError("USAGE", "Pass exactly one of --input <file> or --content <markdown>", usage.trim());
  const theme = THEMES[values.theme];
  if (!theme) throw new ToolError("USAGE", `--theme must be one of ${Object.keys(THEMES).join(", ")}`);
  if (!["16:9", "4:3"].includes(values.ratio)) throw new ToolError("USAGE", "--ratio must be 16:9 or 4:3");
  const source = values.input ? await inputFile(values.input) : undefined;
  const baseDirectory = source ? path.dirname(source) : process.cwd();
  const text = source ? await readText(source) : values.content;
  const output = await outputFile(values.output, ".pptx");
  const slides = outline(blocks(text));
  if (!slides.length) throw new ToolError("EMPTY_DOCUMENT", "The outline has no slides");

  const pptx = new PptxGenJS();
  const wide = values.ratio === "16:9";
  pptx.layout = wide ? "LAYOUT_WIDE" : "LAYOUT_4x3";
  const W = wide ? 13.333 : 10;
  const H = 7.5;
  const margin = 0.6;
  pptx.author = values.author ?? "HarnessHub";
  pptx.company = "HarnessHub";
  pptx.title = slides[0].title ?? path.basename(output, ".pptx");
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT };
  const warnings = [];
  let pictures = 0;
  let tables = 0;
  let charts = 0;

  const footer = (slide, light) => {
    if (values.footer)
      slide.addText(values.footer, { x: margin, y: H - 0.5, w: W - 2.4, h: 0.3, fontFace: FONT, fontSize: 10, color: light ? theme.coverText : theme.muted });
    if (!values["no-page-numbers"])
      slide.slideNumber = { x: W - 1.2, y: H - 0.5, w: 0.7, h: 0.3, fontFace: FONT, fontSize: 10, color: light ? theme.coverText : theme.muted, align: "right" };
  };
  const textRuns = (tokens, base) => {
    const parts = runs(tokens).filter((run) => !run.image);
    return parts.map((run, index) => ({
      text: run.break ? "\n" : run.text,
      options: {
        ...base,
        bold: run.bold || base.bold,
        italic: run.italic,
        strike: run.strike ? "sngStrike" : undefined,
        ...(run.code ? { fontFace: "Consolas" } : {}),
        ...(run.link && /^https?:/i.test(run.link) ? { hyperlink: { url: run.link } } : {}),
        breakLine: index === parts.length - 1,
      },
    }));
  };
  const listRuns = (token, level, target) => {
    for (const item of token.items)
      for (const part of item.tokens) {
        if (part.type === "list") listRuns(part, level + 1, target);
        else if (part.type !== "space" && part.type !== "checkbox") {
          const base = {
            bullet: token.ordered ? { type: "number" } : true,
            indentLevel: level,
            paraSpaceAfter: 6,
          };
          const parts = textRuns(part.tokens ?? [{ type: "text", text: part.text ?? part.raw }], {});
          if (!parts.length) continue;
          if (item.task) parts[0].text = `${item.checked ? "☑" : "☐"} ${parts[0].text}`;
          // Paragraph properties belong to the run that ends the paragraph.
          parts.forEach((run, index) => {
            run.options = { ...(index === parts.length - 1 ? base : { bullet: base.bullet, indentLevel: level }), ...run.options };
          });
          target.push({ lines: 1, runs: parts });
        }
      }
  };

  async function addPicture(slide, item, box) {
    const file = path.resolve(baseDirectory, decodeURIComponent(item.href));
    let bytes;
    try {
      bytes = await readFile(file);
    } catch {
      warnings.push(`Image not found: ${file}`);
      return;
    }
    const info = imageSize(bytes);
    if (!info) {
      warnings.push(`Unsupported image type (use PNG, JPEG, GIF or BMP): ${file}`);
      return;
    }
    const scale = Math.min(box.w / info.width, box.h / info.height);
    const w = info.width * scale;
    const h = info.height * scale;
    slide.addImage({
      data: `image/${info.type === "jpg" ? "jpeg" : info.type};base64,${bytes.toString("base64")}`,
      x: box.x + (box.w - w) / 2,
      y: box.y + (box.h - h) / 2,
      w,
      h,
    });
    pictures++;
  }
  function addTable(slide, token, box) {
    const columns = token.header.length;
    const size = token.rows.length > 8 ? 11 : token.rows.length > 5 ? 12 : 14;
    const cell = (tokens, header, column) => ({
      text: plain(tokens),
      options: {
        bold: header,
        fontFace: FONT,
        fontSize: size,
        color: header ? theme.title : theme.text,
        align: token.align[column] ?? "left",
        valign: "middle",
        ...(header ? { fill: { color: theme.band } } : {}),
      },
    });
    slide.addTable(
      [
        token.header.map((item, column) => cell(item.tokens, true, column)),
        ...token.rows.map((row) => row.map((item, column) => cell(item.tokens, false, column))),
      ],
      { x: box.x, y: box.y, w: box.w, colW: Array.from({ length: columns }, () => box.w / columns), border: { type: "solid", pt: 0.75, color: "BFBFBF" }, autoPage: false },
    );
    tables++;
  }
  function addChart(slide, spec, box) {
    const round = spec.type === "pie" || spec.type === "doughnut";
    slide.addChart(
      pptx.ChartType[CHARTS[spec.type]],
      spec.series.map((series) => ({ name: series.name, labels: spec.labels, values: series.values })),
      {
        ...box,
        ...(spec.type === "bar" ? { barDir: "bar" } : spec.type === "column" ? { barDir: "col" } : {}),
        showTitle: Boolean(spec.title),
        title: spec.title,
        titleFontFace: FONT,
        titleColor: theme.title,
        showLegend: round || spec.series.length > 1,
        legendPos: "b",
        legendFontFace: FONT,
        legendColor: theme.text,
        catAxisLabelFontFace: FONT,
        catAxisLabelColor: theme.text,
        valAxisLabelColor: theme.text,
        ...(round ? { showPercent: true, dataLabelColor: "FFFFFF" } : { showValue: spec.series.length === 1, dataLabelColor: theme.text }),
      },
    );
    charts++;
  }

  let count = 0;
  for (const data of slides) {
    if (data.kind === "cover" || data.kind === "section") {
      const slide = pptx.addSlide();
      count++;
      const cover = data.kind === "cover";
      slide.background = { color: cover ? theme.cover : theme.background };
      if (!cover) slide.addShape(pptx.ShapeType.rect, { x: 0, y: H / 2 - 1.1, w: 0.25, h: 2.2, fill: { color: theme.accent }, line: { color: theme.accent } });
      slide.addText(data.title ?? "", { x: margin + 0.2, y: H / 2 - 1.5, w: W - 2 * margin - 0.4, h: 1.5, fontFace: FONT, fontSize: cover ? 40 : 34, bold: true, color: cover ? theme.coverText : theme.title, valign: "bottom", fit: "shrink" });
      const lines = data.items.filter((item) => item.type === "paragraph").map((item) => plain(item.tokens));
      if (lines.length)
        slide.addText(lines.join("\n"), { x: margin + 0.2, y: H / 2 + 0.15, w: W - 2 * margin - 0.4, h: 1.6, fontFace: FONT, fontSize: 18, color: cover ? theme.coverText : theme.text, valign: "top" });
      if (cover) slide.addShape(pptx.ShapeType.rect, { x: margin + 0.2, y: H / 2 + 0.02, w: 1.4, h: 0.06, fill: { color: theme.accent }, line: { color: theme.accent } });
      if (data.notes.length) slide.addNotes(data.notes.join("\n"));
      footer(slide, cover);
      continue;
    }
    // Text flows into one box; visuals get their own boxes. Long text continues on
    // following slides instead of overflowing.
    const textBlocks = [];
    const visuals = [];
    for (const item of data.items) {
      if (item.type === "paragraph") {
        const parts = textRuns(item.tokens, { paraSpaceAfter: 8 });
        if (parts.length) textBlocks.push({ lines: Math.max(1, Math.ceil(plain(item.tokens).length / 38)), runs: parts });
      } else if (item.type === "subheading")
        textBlocks.push({ lines: 1, runs: textRuns(item.tokens, { bold: true, color: theme.accent, paraSpaceAfter: 6 }) });
      else if (item.type === "list") listRuns(item.token, 0, textBlocks);
      else if (item.type === "code")
        textBlocks.push({ lines: item.text.split("\n").length, runs: [{ text: item.text, options: { fontFace: "Consolas", breakLine: true, paraSpaceAfter: 8 } }] });
      else visuals.push(item);
    }
    const perSlide = visuals.length ? 9 : 13;
    const pages = [];
    let page = [];
    let used = 0;
    for (const entry of textBlocks) {
      if (page.length && used + entry.lines > perSlide) {
        pages.push(page);
        page = [];
        used = 0;
      }
      page.push(entry);
      used += entry.lines;
    }
    if (page.length || !pages.length) pages.push(page);
    for (const [index, entries] of pages.entries()) {
      const slide = pptx.addSlide();
      count++;
      slide.background = { color: theme.background };
      const title = data.title ? `${data.title}${index ? `（${index + 1}）` : ""}` : undefined;
      let top = margin;
      if (title) {
        slide.addText(title, { x: margin, y: 0.35, w: W - 2 * margin, h: 0.9, fontFace: FONT, fontSize: 28, bold: true, color: theme.title, valign: "middle", fit: "shrink" });
        slide.addShape(pptx.ShapeType.rect, { x: margin, y: 1.27, w: 1.2, h: 0.05, fill: { color: theme.accent }, line: { color: theme.accent } });
        top = 1.55;
      }
      const body = { x: margin, y: top, w: W - 2 * margin, h: H - top - 0.75 };
      const shown = index === 0 ? visuals : [];
      const lines = entries.reduce((sum, entry) => sum + entry.lines, 0);
      const fontSize = lines <= 6 ? 20 : lines <= 9 ? 18 : lines <= 12 ? 16 : 14;
      const side = shown.length === 1 && shown[0].type !== "table" && entries.length > 0;
      const textBox = !entries.length
        ? undefined
        : side
          ? { ...body, w: body.w * 0.5 - 0.15 }
          : shown.length
            ? { ...body, h: Math.min(body.h * 0.45, 0.45 * lines + 0.3) }
            : body;
      if (textBox)
        slide.addText(
          entries.flatMap((entry) => entry.runs.map((run) => ({ text: run.text, options: { color: theme.text, ...run.options } }))),
          { ...textBox, fontFace: FONT, fontSize, color: theme.text, valign: "top", margin: 0.05 },
        );
      if (shown.length) {
        const area = !textBox
          ? body
          : side
            ? { x: body.x + body.w * 0.5 + 0.15, y: body.y, w: body.w * 0.5 - 0.15, h: body.h }
            : { x: body.x, y: body.y + textBox.h + 0.15, w: body.w, h: body.h - textBox.h - 0.15 };
        const each = area.h / shown.length;
        for (const [position, item] of shown.entries()) {
          const box = { x: area.x, y: area.y + position * each, w: area.w, h: each - (shown.length > 1 ? 0.1 : 0) };
          if (item.type === "image") await addPicture(slide, item, box);
          else if (item.type === "table") addTable(slide, item.token, box);
          else addChart(slide, item.spec, box);
        }
      }
      if (index === 0 && data.notes.length) slide.addNotes(data.notes.join("\n"));
      footer(slide, false);
    }
    if (pages.length > 1) warnings.push(`"${data.title ?? "slide"}" was long and continues on ${pages.length} slides`);
  }
  const bytes = await pptx.write({ outputType: "nodebuffer" });
  await writeFile(output, bytes);
  finish({ output, bytes: bytes.length, slides: count, tables, charts, images: pictures, ...(warnings.length ? { warnings } : {}) });
}
