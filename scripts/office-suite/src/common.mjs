// Shared helpers of the office-suite tools: argument parsing, tolerant text decoding,
// path handling and the JSON result contract ({"ok":true,...} / {"ok":false,"error":{...}}).
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

/** Failure with a stable code and an actionable hint; rendered as JSON by {@link run}. */
export class ToolError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

/**
 * Parse `argv` with node:util.parseArgs. Unknown options and missing values become a
 * USAGE error that carries the tool's usage text, so an agent can correct its call.
 */
export function parse(argv, options, usage, { positionals = false } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage.trim()}\n`);
    process.exit(0);
  }
  try {
    return parseArgs({
      args: argv,
      options,
      strict: true,
      allowPositionals: positionals,
    });
  } catch (error) {
    throw new ToolError("USAGE", error.message, usage.trim());
  }
}

/** Absolute path of a user-supplied path, relative to the current (Session) directory. */
export function resolvePath(value) {
  if (typeof value !== "string" || !value.trim())
    throw new ToolError("USAGE", "A file path is required");
  return path.resolve(process.cwd(), value.trim().replace(/^["']|["']$/g, ""));
}

/** Resolve an input file and fail clearly when it is missing or not a regular file. */
export async function inputFile(value, label = "input") {
  const file = resolvePath(value);
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new ToolError(
      "INPUT_NOT_FOUND",
      `${label} file does not exist: ${file}`,
      "Write the file first (UTF-8) or pass a path relative to the current working directory.",
    );
  }
  if (!info.isFile())
    throw new ToolError("INPUT_NOT_FILE", `${label} is not a file: ${file}`);
  return file;
}

/** Resolve an output path, enforce its extension and create the parent directory. */
export async function outputFile(value, extension) {
  let file = resolvePath(value);
  if (extension && path.extname(file).toLowerCase() !== extension)
    file += extension;
  await mkdir(path.dirname(file), { recursive: true });
  return file;
}

/**
 * Decode text written by arbitrary Windows tools: BOM (UTF-8, UTF-16 LE/BE) first, then
 * strict UTF-8, then GB18030 (what Windows PowerShell 5.1 `Set-Content`/`>` produce on a
 * Chinese system).
 */
export function decodeText(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

export async function readText(file) {
  return decodeText(await readFile(file));
}

/** RFC 4180 style parser with delimiter detection (comma, tab, semicolon). */
export function parseDelimited(text, delimiter) {
  const source = text.replace(/^\uFEFF/, "");
  let separator = delimiter;
  if (!separator) {
    const first = source.split(/\r?\n/, 1)[0] ?? "";
    const counts = [",", "\t", ";"].map((candidate) => ({
      candidate,
      count: first.split(candidate).length - 1,
    }));
    counts.sort((a, b) => b.count - a.count);
    separator = counts[0].count > 0 ? counts[0].candidate : ",";
  }
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index++;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === separator) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += char;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

/** Spreadsheet-friendly typing of a text cell. */
export function typedValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  if (text === "") return null;
  if (/^=/.test(text)) return { formula: text.slice(1) };
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
  // Keep identifiers such as 007 or 13800138000123456 (long digit strings) as text.
  if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(text)) return Number(text);
  if (/^-?[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/.test(text))
    return Number(text.replaceAll(",", ""));
  if (/^-?\d+(\.\d+)?%$/.test(text))
    return { percent: Number(text.slice(0, -1)) / 100 };
  const date = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(
    text,
  );
  if (date) {
    const [, y, m, d, hh, mm, ss] = date;
    const value = new Date(
      Date.UTC(+y, +m - 1, +d, +(hh ?? 0), +(mm ?? 0), +(ss ?? 0)),
    );
    if (value.getUTCMonth() === +m - 1 && value.getUTCDate() === +d)
      return { date: value, time: hh !== undefined };
  }
  return raw;
}

/** Print the single JSON result line every tool ends with. */
export function finish(result) {
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

/** Run a tool entry point and turn failures into the JSON error contract (exit code 1). */
export async function run(main) {
  try {
    await main();
  } catch (error) {
    const known = error instanceof ToolError;
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: {
          code: known ? error.code : "TOOL_FAILED",
          message: String(error?.message ?? error),
          ...(known && error.hint ? { hint: error.hint } : {}),
        },
      })}\n`,
    );
    process.exitCode = 1;
  }
}
