// pdf_create: Markdown / HTML / text / Office documents -> PDF without any installation.
// Text formats are printed by the headless Edge or Chrome that ships with Windows; Office
// documents use the installed Office (COM) and fall back to a text rendering.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { marked } from "marked";
import { finish, inputFile, outputFile, parse, readText, ToolError } from "./common.mjs";
import { powershell } from "./win.mjs";

const usage = `
pdf_create --input <file.md|.txt|.html|.docx|.xlsx|.pptx> --output <file.pdf> [--title 标题] [--landscape]
.md/.txt/.html are printed with the built-in headless Microsoft Edge (or Chrome). .docx/.xlsx/
.pptx are exported by the installed Word/Excel/PowerPoint; without Office their text content
is printed instead ("fidelity":"text-only"). Prints {"ok":true,"output":...,"method":...}.`;

const OFFICE = String.raw`
$source = [string]$in.source
$output = [string]$in.output
$app = $null
try {
  if ($in.kind -eq 'word') {
    $app = New-Object -ComObject Word.Application
    $app.Visible = $false
    $app.DisplayAlerts = 0
    $document = $app.Documents.Open($source, $false, $true)
    $document.ExportAsFixedFormat($output, 17)
    $document.Close($false)
    $app.Quit()
  } elseif ($in.kind -eq 'excel') {
    $app = New-Object -ComObject Excel.Application
    $app.Visible = $false
    $app.DisplayAlerts = $false
    $workbook = $app.Workbooks.Open($source, 0, $true)
    $workbook.ExportAsFixedFormat(0, $output)
    $workbook.Close($false)
    $app.Quit()
  } else {
    $app = New-Object -ComObject PowerPoint.Application
    $presentation = $app.Presentations.Open($source, -1, 0, 0)
    $presentation.SaveAs($output, 32)
    $presentation.Close()
    # PowerPoint is a single instance: leave it running when the user has other files open.
    if ($app.Presentations.Count -eq 0) { $app.Quit() }
  }
} catch {
  if ($null -eq $app) { Fail 'OFFICE_UNAVAILABLE' 'Microsoft Office is not installed' $null }
  try { $app.Quit() } catch { }
  Fail 'OFFICE_EXPORT_FAILED' $_.Exception.Message $null
}
Write-Result @{ ok = $true; exists = (Test-Path -LiteralPath $output) }
`;

const STYLE = `
@page { size: A4 PAGE_ORIENTATION; margin: 20mm 18mm; }
body { font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "SimSun", "Segoe UI", Arial, sans-serif; font-size: 11pt; line-height: 1.7; color: #1f2937; }
h1 { font-size: 20pt; margin: 0 0 12pt; } h2 { font-size: 15pt; margin: 18pt 0 8pt; } h3 { font-size: 13pt; margin: 14pt 0 6pt; }
h1, h2, h3, h4 { color: #111827; page-break-after: avoid; }
table { border-collapse: collapse; width: 100%; margin: 8pt 0 12pt; page-break-inside: avoid; }
th, td { border: 1px solid #bfbfbf; padding: 4pt 7pt; text-align: left; vertical-align: top; }
th { background: #deeaf6; }
code, pre { font-family: Consolas, "Courier New", monospace; font-size: 10pt; }
pre { background: #f5f5f5; padding: 8pt; white-space: pre-wrap; word-break: break-all; }
blockquote { margin: 8pt 0; padding: 2pt 12pt; border-left: 3px solid #a6a6a6; color: #595959; }
img { max-width: 100%; } hr { border: 0; border-top: 1px solid #bfbfbf; margin: 14pt 0; }
`;

function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === "win32")
    return [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA]
      .filter(Boolean)
      .flatMap((root) => [
        path.win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      ])
      .sort((a, b) => Number(b.includes("msedge")) - Number(a.includes("msedge")));
  if (platform === "darwin")
    return [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  return ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

async function printHtml(html, output, baseDirectory) {
  const browser = browserCandidates().find((candidate) => existsSync(candidate));
  if (!browser)
    throw new ToolError(
      "NO_BROWSER",
      "Neither Microsoft Edge nor Chrome was found for PDF printing",
      "With Microsoft Office installed, create a .docx first and run pdf_create on it; otherwise deliver the .docx/.html file.",
    );
  const work = path.join(os.tmpdir(), `hh-office-pdf-${randomBytes(8).toString("hex")}`);
  await mkdir(work, { recursive: true });
  // The page lives next to the source so that relative images resolve.
  const page = path.join(baseDirectory, `.hh-print-${randomBytes(6).toString("hex")}.html`);
  try {
    await writeFile(page, html, "utf8");
    await rm(output, { force: true });
    // Headless Chromium sometimes keeps running after the PDF is complete (seen on macOS
    // and with a busy profile lock on Windows): wait for a stable file, then end it.
    const code = await new Promise((resolve, reject) => {
      const child = spawn(
        browser,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          `--user-data-dir=${work}`,
          "--no-pdf-header-footer",
          `--print-to-pdf=${output}`,
          pathToFileURL(page).href,
        ],
        { stdio: "ignore", windowsHide: true },
      );
      let settled = false;
      let lastSize = -1;
      let stable = 0;
      const done = (action, value) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        action(value);
      };
      const poll = setInterval(() => {
        stat(output).then(
          (info) => {
            stable = info.size > 0 && info.size === lastSize ? stable + 1 : 0;
            lastSize = info.size;
            if (stable >= 3) {
              child.kill();
              done(resolve, 0);
            }
          },
          () => undefined,
        );
      }, 400);
      const timer = setTimeout(() => {
        child.kill();
        done(reject, new ToolError("TIMEOUT", "The browser did not finish printing within 25 s"));
      }, 25000);
      child.once("error", (error) => done(reject, new ToolError("BROWSER_FAILED", error.message)));
      child.once("close", (exit) => done(resolve, exit));
    });
    const info = await stat(output).catch(() => undefined);
    if (!info?.size) throw new ToolError("BROWSER_FAILED", `${path.basename(browser)} exited with code ${code} without writing the PDF`);
    return { browser: path.basename(browser), bytes: info.size };
  } finally {
    await rm(page, { force: true });
    await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}

function document(body, title, landscape) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE.replace("PAGE_ORIENTATION", landscape ? "landscape" : "portrait")}</style></head><body>${body}</body></html>`;
}

export async function pdfCreate(argv) {
  const { values } = parse(
    argv,
    {
      input: { type: "string" },
      output: { type: "string" },
      title: { type: "string" },
      landscape: { type: "boolean", default: false },
    },
    usage,
  );
  if (!values.input || !values.output) throw new ToolError("USAGE", "--input and --output are required", usage.trim());
  const source = await inputFile(values.input);
  const output = await outputFile(values.output, ".pdf");
  const extension = path.extname(source).toLowerCase();
  const title = values.title ?? path.basename(source, extension);
  const kind = { ".docx": "word", ".doc": "word", ".rtf": "word", ".xlsx": "excel", ".xls": "excel", ".pptx": "powerpoint", ".ppt": "powerpoint" }[extension];
  if (kind) {
    let failure;
    if (process.platform === "win32") {
      await rm(output, { force: true });
      try {
        await powershell(OFFICE, { source, output, kind }, 28000);
        const info = await stat(output).catch(() => undefined);
        if (info?.size) return finish({ output, bytes: info.size, method: `office-${kind}`, fidelity: "exact" });
      } catch (error) {
        failure = error;
        if (error.code !== "OFFICE_UNAVAILABLE" && error.code !== "POWERSHELL_UNAVAILABLE") throw error;
      }
    }
    if (![".docx", ".xlsx", ".pptx"].includes(extension))
      throw failure ?? new ToolError("OFFICE_UNAVAILABLE", `${extension} needs Microsoft Office for PDF export`);
    // No Office: print the text content so that the task still yields a readable PDF.
    const { officeText } = await import("./office-read.mjs");
    const markdown = (await officeText(source, { maxRows: 2000, json: false })).content;
    const printed = await printHtml(document(marked.parse(markdown, { gfm: true }), title, values.landscape), output, path.dirname(source));
    return finish({ output, ...printed, method: "browser-print", fidelity: "text-only", note: "Microsoft Office is not installed: the PDF contains the document text, not its original layout." });
  }
  const text = (await readText(source)).replace(
    /^[ \t]*(\\pagebreak|\\newpage|\[\[pagebreak\]\]|<!--\s*pagebreak\s*-->)[ \t]*$/gim,
    '<div style="page-break-after: always"></div>',
  );
  const html = /\.html?$/i.test(source)
    ? text
    : document(/\.(md|markdown)$/i.test(source) ? marked.parse(text, { gfm: true }) : `<pre style="background:none;padding:0;font-family:inherit;font-size:inherit">${escapeHtml(text)}</pre>`, title, values.landscape);
  const printed = await printHtml(html, output, path.dirname(source));
  finish({ output, ...printed, method: "browser-print" });
}
