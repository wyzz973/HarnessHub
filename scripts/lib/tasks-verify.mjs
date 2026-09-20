/**
 * Final-state checks for the competition task suite (scripts/competition-tasks.mjs).
 * Every check is dependency-free and reads only the task directory, the agent's reply or
 * the local process list. A check never throws for "the agent did it wrong"; it returns
 * `{kind, ok, summary}` so a whole tree (`any_of` / `all_of` / `not`) can be reported.
 *
 * Check kinds: file_exists, file_absent, file_text_contains, file_text_equals,
 * file_text_matches, office_text_contains, xlsx_cell, xlsx_find, csv_rows, json_valid,
 * ics_valid, eml_headers, zip_contains, not_modified, process_running, window_title,
 * shell_window, reply_contains, reply_matches, any_of, all_of, not.
 * Field reference: docs/competition-tasks.md.
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { officeFormat, readOffice } from "./tasks-office.mjs";
import { readZip } from "./tasks-zip.mjs";

const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_WALK_ENTRIES = 5000;
const MAX_WALK_DEPTH = 8;

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/**
 * Decode a text file the way office tools on Windows write it: UTF-8 (with or without
 * BOM), UTF-16 LE/BE with BOM, and legacy GBK when the bytes are not valid UTF-8
 * (Windows PowerShell 5.1 `Set-Content` on a Chinese system).
 */
export function decodeTextFile(bytes) {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  )
    return bytes.subarray(3).toString("utf8");
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("gbk", { fatal: true }).decode(bytes);
    } catch {
      return bytes.toString("latin1");
    }
  }
}

/** RFC 4180 style CSV parser (quotes, doubled quotes, CR/LF inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index++;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += char;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim() !== ""));
}

/** Unfold and parse an iCalendar document into `{calendar: boolean, events: Map[]}`. */
export function parseIcs(text) {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const unescape = (value) =>
    value.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
  const events = [];
  let current;
  let depth = 0;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      current = new Map();
      depth = 0;
      continue;
    }
    if (upper === "END:VEVENT") {
      if (current) events.push(current);
      current = undefined;
      continue;
    }
    if (!current) continue;
    if (upper.startsWith("BEGIN:")) depth++;
    else if (upper.startsWith("END:")) depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const name = line.slice(0, colon).split(";")[0].toUpperCase();
      const value = unescape(line.slice(colon + 1));
      if (!current.has(name)) current.set(name, []);
      current.get(name).push({ raw: line.slice(0, colon), value });
    }
  }
  const upperLines = lines.map((line) => line.toUpperCase());
  return {
    calendar:
      upperLines[0] === "BEGIN:VCALENDAR" &&
      upperLines.includes("END:VCALENDAR"),
    events,
  };
}

function decodeCharset(bytes, charset) {
  const label = (charset ?? "utf-8").trim().toLowerCase();
  try {
    return new TextDecoder(label === "gb2312" ? "gbk" : label).decode(bytes);
  } catch {
    return decodeTextFile(bytes);
  }
}

function decodeQuotedPrintable(text, header) {
  const source = header
    ? text.replaceAll("_", " ")
    : text.replace(/=\r?\n/g, "");
  const bytes = [];
  for (let index = 0; index < source.length; index++) {
    const hex = source.slice(index + 1, index + 3);
    if (source[index] === "=" && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else bytes.push(...Buffer.from(source[index], "utf8"));
  }
  return Buffer.from(bytes);
}

/** Decode RFC 2047 encoded words (`=?utf-8?B?...?=`) inside a header value. */
export function decodeMimeWords(value) {
  return value
    .replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(
      /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
      (_match, charset, encoding, text) =>
        decodeCharset(
          encoding.toLowerCase() === "b"
            ? Buffer.from(text, "base64")
            : decodeQuotedPrintable(text, true),
          charset,
        ),
    );
}

function headerParameters(value) {
  const parameters = new Map();
  const continued = new Map();
  for (const match of value.matchAll(
    /;\s*([A-Za-z0-9_.-]+)(\*[0-9]+)?(\*)?\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g,
  )) {
    const name = match[1].toLowerCase();
    let text = match[4].trim();
    if (text.startsWith('"')) text = text.slice(1, -1).replace(/\\(.)/g, "$1");
    if (match[2] || match[3]) {
      if (!continued.has(name)) continued.set(name, []);
      continued.get(name).push({
        order: match[2] ? Number(match[2].slice(1)) : 0,
        extended: Boolean(match[3]),
        text,
      });
    } else parameters.set(name, decodeMimeWords(text));
  }
  for (const [name, pieces] of continued) {
    pieces.sort((a, b) => a.order - b.order);
    let charset = "utf-8";
    let bytes = Buffer.alloc(0);
    for (const [index, piece] of pieces.entries()) {
      let text = piece.text;
      if (piece.extended) {
        if (index === 0) {
          const parts = /^([^']*)'[^']*'(.*)$/.exec(text);
          if (parts) {
            charset = parts[1] || "utf-8";
            text = parts[2];
          }
        }
        bytes = Buffer.concat([
          bytes,
          Buffer.from(
            text.replace(/%([0-9a-fA-F]{2})/g, (_m, hex) =>
              String.fromCharCode(Number.parseInt(hex, 16)),
            ),
            "latin1",
          ),
        ]);
      } else bytes = Buffer.concat([bytes, Buffer.from(text, "utf8")]);
    }
    parameters.set(name, decodeCharset(bytes, charset));
  }
  return parameters;
}

function parseMimeEntity(text, depth) {
  const split = /\r?\n\r?\n/.exec(text);
  const head = split ? text.slice(0, split.index) : text;
  const body = split ? text.slice(split.index + split[0].length) : "";
  const headers = new Map();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, []);
    headers.get(name).push(line.slice(colon + 1).trim());
  }
  const contentType = headers.get("content-type")?.[0] ?? "text/plain";
  const typeParameters = headerParameters(contentType);
  const disposition = headers.get("content-disposition")?.[0] ?? "";
  const dispositionParameters = headerParameters(disposition);
  const entity = {
    headers,
    type: contentType.split(";")[0].trim().toLowerCase(),
    fileName:
      dispositionParameters.get("filename") ?? typeParameters.get("name"),
    attachment: /^\s*attachment/i.test(disposition),
    text: "",
    parts: [],
  };
  const boundary = typeParameters.get("boundary");
  if (entity.type.startsWith("multipart/") && boundary && depth < 6) {
    const marker = `--${boundary}`;
    const sections = body.split(marker).slice(1);
    for (const section of sections) {
      if (section.startsWith("--")) break;
      entity.parts.push(
        parseMimeEntity(section.replace(/^\r?\n/, ""), depth + 1),
      );
    }
    return entity;
  }
  const encoding = (headers.get("content-transfer-encoding")?.[0] ?? "7bit")
    .trim()
    .toLowerCase();
  if (entity.type.startsWith("text/") || !headers.has("content-type")) {
    const charset = typeParameters.get("charset");
    // 7bit/8bit bodies were already decoded together with the whole file.
    entity.text =
      encoding === "base64"
        ? decodeCharset(
            Buffer.from(body.replace(/\s+/g, ""), "base64"),
            charset,
          )
        : encoding === "quoted-printable"
          ? decodeCharset(decodeQuotedPrintable(body, false), charset)
          : body;
  }
  return entity;
}

/**
 * Parse an RFC 5322 / MIME message: decoded top-level headers, the text of every text
 * part and the file names of every part that declares one.
 */
export function parseEml(source) {
  const root = parseMimeEntity(source.replace(/^\uFEFF/, ""), 0);
  const headers = new Map();
  for (const [name, values] of root.headers)
    headers.set(name, values.map(decodeMimeWords).join(", "));
  const texts = [];
  const attachments = [];
  const visit = (entity) => {
    if (entity.fileName) attachments.push(entity.fileName);
    if (entity.text && !entity.attachment) texts.push(entity.text);
    entity.parts.forEach(visit);
  };
  visit(root);
  return { headers, text: texts.join("\n"), attachments };
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: "buffer",
      },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          error: error ? String(error.message) : undefined,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ""),
        }),
    );
  });
}

/** Absolute path of Windows PowerShell 5.1; PATH is not trusted to contain it. */
export function windowsPowerShell(env = process.env) {
  return path.win32.join(
    env.SystemRoot ?? env.windir ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

/**
 * Run a Windows PowerShell 5.1 script that assigns `$result` and return it as JSON.
 * The script travels as -EncodedCommand (no quoting problems) and the JSON comes back
 * ASCII-escaped, so neither the console code page nor a missing console can corrupt
 * Chinese window titles or paths.
 */
export async function powershellJson(script, options = {}) {
  const wrapped = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n${script}\n$json = ConvertTo-Json -InputObject $result -Compress -Depth 6\n[regex]::Replace($json, '[^\\x00-\\x7F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value })`;
  const runner = options.run ?? run;
  const outcome = await runner(
    windowsPowerShell(options.env),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(wrapped, "utf16le").toString("base64"),
    ],
    { timeoutMs: options.timeoutMs ?? 90_000 },
  );
  const text = outcome.stdout.toString("utf8").trim();
  const start = text.search(/[[{]/);
  if (outcome.code !== 0 || start < 0)
    throw new Error(
      `PowerShell failed (${outcome.code}): ${(outcome.stderr.toString("utf8") || outcome.error || text).slice(0, 400)}`,
    );
  return JSON.parse(text.slice(start));
}

function processName(value) {
  return path.win32
    .basename(path.posix.basename(String(value).trim()))
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

/**
 * List local processes as `{pid, name, commandLine?}` (name: lower case, no `.exe`).
 * Windows: tasklist, or CIM through PowerShell when command lines are needed.
 * macOS/Linux: ps.
 */
export async function listProcesses(options = {}) {
  const platform = options.platform ?? process.platform;
  const runner = options.run ?? run;
  if (platform === "win32") {
    if (options.commandLines) {
      const result = await powershellJson(
        "$result = @{ items = @(Get-CimInstance Win32_Process | ForEach-Object { @{ pid = [int]$_.ProcessId; name = [string]$_.Name; commandLine = [string]$_.CommandLine } }) }",
        options,
      );
      return list(result.items).map((item) => ({
        pid: Number(item.pid),
        name: processName(item.name ?? ""),
        commandLine: String(item.commandLine ?? ""),
      }));
    }
    const outcome = await runner(
      path.win32.join(
        (options.env ?? process.env).SystemRoot ?? "C:\\Windows",
        "System32",
        "tasklist.exe",
      ),
      ["/FO", "CSV", "/NH"],
      {},
    );
    if (outcome.code !== 0)
      throw new Error(`tasklist failed: ${outcome.error ?? outcome.code}`);
    return parseCsv(decodeTextFile(outcome.stdout))
      .filter((cells) => cells.length >= 2 && /^\d+$/.test(cells[1].trim()))
      .map((cells) => ({
        pid: Number(cells[1]),
        name: processName(cells[0]),
      }));
  }
  const outcome = await runner(
    "ps",
    ["-axo", options.commandLines ? "pid=,args=" : "pid=,comm="],
    {},
  );
  if (outcome.code !== 0)
    throw new Error(`ps failed: ${outcome.error ?? outcome.code}`);
  return outcome.stdout
    .toString("utf8")
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      name: processName(
        options.commandLines ? match[2].split(/\s+/)[0] : match[2],
      ),
      ...(options.commandLines ? { commandLine: match[2] } : {}),
    }));
}

/**
 * Whether the machine has what a task needs. `requirement.kind === "app_installed"`
 * looks up App Paths registry keys (`app_paths`), commands on PATH (`commands`), Store
 * packages (`appx`) and files (`files`, %VAR% expanded); any hit satisfies it.
 */
export async function checkRequirement(requirement, options = {}) {
  const platform = options.platform ?? process.platform;
  if (!isObject(requirement) || requirement.kind !== "app_installed")
    throw new Error(`Unknown requirement kind: ${requirement?.kind}`);
  if (platform === "win32") {
    const spec = JSON.stringify({
      appPaths: list(requirement.app_paths),
      commands: list(requirement.commands),
      appx: list(requirement.appx),
      files: list(requirement.files),
    }).replaceAll("'", "''");
    const result = await powershellJson(
      `$spec = ConvertFrom-Json '${spec}'
$found = @()
$roots = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths'
foreach ($name in @($spec.appPaths)) {
  foreach ($root in $roots) {
    $key = Join-Path $root $name
    if (Test-Path -LiteralPath $key) {
      $value = (Get-Item -LiteralPath $key).GetValue('')
      if ($value) {
        $exe = [Environment]::ExpandEnvironmentVariables(([string]$value).Trim('"'))
        if (Test-Path -LiteralPath $exe) { $found += "app-path:$exe" }
      }
    }
  }
}
foreach ($command in @($spec.commands)) {
  $hit = Get-Command $command -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { $found += "command:$($hit.Source)" }
}
foreach ($package in @($spec.appx)) {
  try {
    $hit = Get-AppxPackage -Name $package -ErrorAction Stop | Select-Object -First 1
    if ($hit) { $found += "appx:$($hit.PackageFullName)" }
  } catch { }
}
foreach ($file in @($spec.files)) {
  $expanded = [Environment]::ExpandEnvironmentVariables([string]$file)
  if (Test-Path -LiteralPath $expanded) { $found += "file:$expanded" }
}
$result = @{ found = @($found) }`,
      options,
    );
    const found = list(result.found).map(String);
    return { satisfied: found.length > 0, evidence: found };
  }
  const found = [];
  const runner = options.run ?? run;
  for (const command of list(requirement.commands)) {
    const outcome = await runner("which", [command], {});
    if (outcome.code === 0)
      found.push(`command:${outcome.stdout.toString("utf8").trim()}`);
  }
  for (const file of list(requirement.files))
    if (await stat(file).catch(() => undefined)) found.push(`file:${file}`);
  return { satisfied: found.length > 0, evidence: found };
}

function globToRegExp(pattern) {
  let source = "";
  const text = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "*") {
      if (text[index + 1] === "*") {
        index++;
        if (text[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else source += ".*";
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

async function walk(directory) {
  const found = [];
  const visit = async (current, relative, depth) => {
    if (depth > MAX_WALK_DEPTH || found.length >= MAX_WALK_ENTRIES) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_WALK_ENTRIES) return;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        found.push({ relative: next, directory: true });
        await visit(path.join(current, entry.name), next, depth + 1);
      } else if (entry.isFile())
        found.push({ relative: next, directory: false });
    }
  };
  await visit(directory, "", 0);
  return found;
}

/**
 * Files (and directories) under `directory` whose relative path matches `pattern`
 * (`*`, `?`, `**`; case-insensitive because Windows and macOS file systems are).
 * Absolute patterns and `..` segments are rejected.
 */
export async function findPaths(directory, pattern) {
  const normalized = String(pattern).replaceAll("\\", "/");
  if (
    path.isAbsolute(pattern) ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  )
    throw new Error(
      `Check path must stay inside the task directory: ${pattern}`,
    );
  const matcher = globToRegExp(normalized.replace(/\/+$/, ""));
  return (await walk(directory))
    .filter((entry) => matcher.test(entry.relative))
    .map((entry) => ({
      ...entry,
      absolute: path.join(directory, ...entry.relative.split("/")),
    }));
}

async function sha256(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

/** SHA-256 of every file below `directory`, keyed by its relative POSIX path. */
export async function snapshotHashes(directory) {
  const hashes = new Map();
  for (const entry of await walk(directory))
    if (!entry.directory)
      hashes.set(
        entry.relative.toLowerCase(),
        await sha256(path.join(directory, ...entry.relative.split("/"))),
      );
  return hashes;
}

function expand(value, variables) {
  if (typeof value === "string")
    return value.replace(/\$\{([a-z_]+)\}/g, (match, name) =>
      Object.hasOwn(variables, name) ? variables[name] : match,
    );
  if (Array.isArray(value)) return value.map((item) => expand(item, variables));
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        expand(item, variables),
      ]),
    );
  return value;
}

let computerName;
/** The name a user sees for this machine (macOS ComputerName, Windows COMPUTERNAME). */
function localComputerName() {
  if (computerName !== undefined) return computerName;
  computerName = process.env.COMPUTERNAME ?? os.hostname().split(".")[0];
  if (process.platform === "darwin")
    try {
      computerName =
        execFileSync("scutil", ["--get", "ComputerName"], {
          encoding: "utf8",
          timeout: 5000,
        }).trim() || computerName;
    } catch {
      // Keep the host name.
    }
  return computerName;
}

/**
 * Placeholders usable in check strings: `${hostname}`, `${hostname_short}`,
 * `${computer_name}`, `${username}`, `${directory}`, `${directory_name}`.
 */
export function checkVariables(directory) {
  const hostname = os.hostname();
  return {
    hostname,
    hostname_short: hostname.split(".")[0],
    computer_name: localComputerName(),
    username: os.userInfo().username,
    directory,
    directory_name: path.basename(directory),
  };
}

const fold = (text, ignoreCase) => (ignoreCase ? text.toLowerCase() : text);
const squash = (text) => text.replace(/\s+/g, "");

function containsAll(haystack, check, label) {
  const ignoreCase = check.ignore_case !== false;
  const source = fold(haystack, ignoreCase);
  const loose = squash(source);
  // Agents insert spaces between Chinese and Latin text ("10 月 15 日"); compare without
  // whitespace as well so the facts, not the typography, decide.
  const has = (needle) => {
    const wanted = fold(String(needle), ignoreCase);
    return source.includes(wanted) || loose.includes(squash(wanted));
  };
  const missing = list(check.contains).filter((needle) => !has(needle));
  if (missing.length)
    return `${label} does not contain: ${missing.map((item) => JSON.stringify(item)).join(", ")}`;
  const any = list(check.any);
  if (any.length && !any.some(has))
    return `${label} contains none of: ${any.map((item) => JSON.stringify(item)).join(", ")}`;
  return undefined;
}

function closeTo(actual, expected, tolerance = 0.005) {
  return (
    typeof actual === "number" &&
    Number.isFinite(actual) &&
    Math.abs(actual - Number(expected)) <= tolerance
  );
}

function subsetProblem(actual, expected, tolerance, where = "$") {
  if (typeof expected === "number") {
    const value =
      typeof actual === "string" && actual.trim() !== ""
        ? Number(actual)
        : actual;
    return closeTo(value, expected, tolerance)
      ? undefined
      : `${where} is ${JSON.stringify(actual)}, expected ${expected}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${where} is not an array`;
    for (const [index, item] of expected.entries()) {
      const hit = actual.some(
        (candidate) =>
          subsetProblem(candidate, item, tolerance, `${where}[${index}]`) ===
          undefined,
      );
      if (!hit)
        return `${where} has no element matching ${JSON.stringify(item)}`;
    }
    return undefined;
  }
  if (isObject(expected)) {
    if (!isObject(actual)) return `${where} is not an object`;
    for (const [key, item] of Object.entries(expected)) {
      if (!Object.hasOwn(actual, key)) return `${where}.${key} is missing`;
      const problem = subsetProblem(
        actual[key],
        item,
        tolerance,
        `${where}.${key}`,
      );
      if (problem) return problem;
    }
    return undefined;
  }
  return actual === expected
    ? undefined
    : `${where} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
}

/**
 * Build the check runner.
 *
 * @param {{platform?: NodeJS.Platform, run?: Function, env?: NodeJS.ProcessEnv}} [options]
 *   `run(command, args, {timeoutMs})` replaces process execution in tests.
 * @returns {(check: object, context: {directory: string, reply: string,
 *   baseline?: Map<string, string>}) => Promise<{kind: string, ok: boolean,
 *   summary: string, children?: object[]}>} Unknown kinds and malformed checks yield
 *   `ok: false` with the reason; they never pass silently.
 */
export function createVerifier(options = {}) {
  const platform = options.platform ?? process.platform;
  const system = { ...options, platform };

  const single = async (directory, check) => {
    const matches = (await findPaths(directory, check.path)).filter(
      (entry) => !entry.directory,
    );
    if (!matches.length) return { problem: `${check.path} was not created` };
    const file = matches[0];
    const info = await stat(file.absolute);
    if (info.size > MAX_TEXT_BYTES)
      return { problem: `${file.relative} is larger than the check limit` };
    return { file, bytes: await readFile(file.absolute) };
  };
  const text = async (directory, check) => {
    const loaded = await single(directory, check);
    return loaded.problem
      ? loaded
      : { ...loaded, text: decodeTextFile(loaded.bytes) };
  };
  const office = async (directory, check) => {
    const loaded = await single(directory, check);
    if (loaded.problem) return loaded;
    const format = check.format ?? officeFormat(loaded.file.relative);
    if (!format)
      return {
        problem: `${loaded.file.relative} is not a docx, xlsx or pptx file`,
      };
    try {
      return { ...loaded, document: readOffice(loaded.bytes, format) };
    } catch (error) {
      return { problem: `${loaded.file.relative}: ${error.message}` };
    }
  };
  const sheetOf = (document, check) => {
    if (check.sheet === undefined) return document.sheets[0];
    return typeof check.sheet === "number"
      ? document.sheets[check.sheet]
      : document.sheets.find(
          (sheet) =>
            sheet.name.toLowerCase() === String(check.sheet).toLowerCase(),
        );
  };
  const cellProblem = (cell, check) => {
    if (!cell) return "cell is empty";
    if (check.formula === true && cell.formula === undefined)
      return "cell has no formula";
    if (
      check.formula_contains !== undefined &&
      !(cell.formula ?? "")
        .toUpperCase()
        .includes(String(check.formula_contains).toUpperCase())
    )
      return `formula ${JSON.stringify(cell.formula ?? null)} does not contain ${check.formula_contains}`;
    if (check.number !== undefined) {
      const value =
        typeof cell.value === "string" ? Number(cell.value) : cell.value;
      if (!closeTo(value, check.number, check.tolerance))
        return `value ${JSON.stringify(cell.value ?? null)} is not ${check.number}`;
    }
    if (
      check.equals !== undefined &&
      String(cell.value ?? "").trim() !== String(check.equals).trim()
    )
      return `value ${JSON.stringify(cell.value ?? null)} is not ${JSON.stringify(check.equals)}`;
    if (
      check.text_contains !== undefined &&
      !String(cell.value ?? "").includes(String(check.text_contains))
    )
      return `value ${JSON.stringify(cell.value ?? null)} does not contain ${JSON.stringify(check.text_contains)}`;
    return undefined;
  };

  const kinds = {
    async file_exists(check, context) {
      const matches = (await findPaths(context.directory, check.path)).filter(
        (entry) => Boolean(check.directory) === entry.directory,
      );
      const minimum = check.min_count ?? 1;
      if (matches.length < minimum)
        return `${check.path}: found ${matches.length}, need at least ${minimum}`;
      if (check.max_count !== undefined && matches.length > check.max_count)
        return `${check.path}: found ${matches.length}, at most ${check.max_count} allowed`;
      if (check.min_bytes !== undefined)
        for (const entry of matches)
          if ((await stat(entry.absolute)).size < check.min_bytes)
            return `${entry.relative} is smaller than ${check.min_bytes} bytes`;
      return undefined;
    },
    async file_absent(check, context) {
      const matches = await findPaths(context.directory, check.path);
      return matches.length ? `${matches[0].relative} still exists` : undefined;
    },
    async file_text_contains(check, context) {
      const loaded = await text(context.directory, check);
      if (loaded.problem) return loaded.problem;
      const length = [...loaded.text.trim()].length;
      if (check.min_chars !== undefined && length < check.min_chars)
        return `${loaded.file.relative} has ${length} characters, fewer than ${check.min_chars}`;
      if (check.max_chars !== undefined && length > check.max_chars)
        return `${loaded.file.relative} has ${length} characters, more than ${check.max_chars}`;
      return containsAll(loaded.text, check, loaded.file.relative);
    },
    async file_text_equals(check, context) {
      const loaded = await text(context.directory, check);
      if (loaded.problem) return loaded.problem;
      const normalize = (value) =>
        fold(
          String(value).replace(/\r\n?/g, "\n").trim(),
          check.ignore_case === true,
        );
      return normalize(loaded.text) === normalize(check.equals)
        ? undefined
        : `${loaded.file.relative} is ${JSON.stringify(loaded.text.slice(0, 120))}, expected ${JSON.stringify(check.equals)}`;
    },
    async file_text_matches(check, context) {
      const loaded = await text(context.directory, check);
      if (loaded.problem) return loaded.problem;
      const flags = new Set([...(check.flags ?? "m"), "g"]);
      const count = [
        ...loaded.text.matchAll(new RegExp(check.pattern, [...flags].join(""))),
      ].length;
      const minimum = check.min_matches ?? 1;
      return count >= minimum
        ? undefined
        : `${loaded.file.relative}: /${check.pattern}/ matched ${count} time(s), need ${minimum}`;
    },
    async office_text_contains(check, context) {
      const loaded = await office(context.directory, check);
      if (loaded.problem) return loaded.problem;
      const { document, file } = loaded;
      for (const [field, property] of [
        ["min_tables", "tables"],
        ["min_slides", "slides"],
        ["min_paragraphs", "paragraphs"],
      ])
        if (
          check[field] !== undefined &&
          (document[property] ?? 0) < check[field]
        )
          return `${file.relative} has ${document[property] ?? 0} ${property}, need ${check[field]}`;
      return containsAll(document.text, check, file.relative);
    },
    async xlsx_cell(check, context) {
      const loaded = await office(context.directory, {
        ...check,
        format: "xlsx",
      });
      if (loaded.problem) return loaded.problem;
      const sheet = sheetOf(loaded.document, check);
      if (!sheet) return `${loaded.file.relative} has no sheet ${check.sheet}`;
      const problem = cellProblem(
        sheet.cells.get(String(check.cell).toUpperCase()),
        check,
      );
      return problem
        ? `${loaded.file.relative} ${sheet.name}!${check.cell}: ${problem}`
        : undefined;
    },
    async xlsx_find(check, context) {
      const loaded = await office(context.directory, {
        ...check,
        format: "xlsx",
      });
      if (loaded.problem) return loaded.problem;
      const sheets =
        check.sheet === undefined
          ? loaded.document.sheets
          : [sheetOf(loaded.document, check)].filter(Boolean);
      for (const sheet of sheets)
        for (const cell of sheet.cells.values())
          if (cellProblem(cell, check) === undefined) return undefined;
      return `${loaded.file.relative}: no cell matches ${JSON.stringify(
        Object.fromEntries(
          Object.entries(check).filter(
            ([key]) => !["kind", "path"].includes(key),
          ),
        ),
      )}`;
    },
    async csv_rows(check, context) {
      const loaded = await text(context.directory, check);
      if (loaded.problem) return loaded.problem;
      const rows = parseCsv(loaded.text).map((cells) =>
        cells.map((value) => value.trim()),
      );
      if (!rows.length) return `${loaded.file.relative} is empty`;
      const [header, ...data] = rows;
      if (check.header) {
        const wanted = check.header.map(String);
        const same = check.header_any_order
          ? wanted.length === header.length &&
            wanted.every((name) => header.includes(name))
          : wanted.length === header.length &&
            wanted.every((name, index) => header[index] === name);
        if (!same)
          return `${loaded.file.relative} header is ${JSON.stringify(header)}, expected ${JSON.stringify(wanted)}`;
      }
      if (check.row_count !== undefined && data.length !== check.row_count)
        return `${loaded.file.relative} has ${data.length} data rows, expected ${check.row_count}`;
      if (check.min_rows !== undefined && data.length < check.min_rows)
        return `${loaded.file.relative} has ${data.length} data rows, need at least ${check.min_rows}`;
      if (check.max_rows !== undefined && data.length > check.max_rows)
        return `${loaded.file.relative} has ${data.length} data rows, at most ${check.max_rows} allowed`;
      if (check.unique_by !== undefined) {
        const column = header.indexOf(String(check.unique_by));
        if (column < 0)
          return `${loaded.file.relative} has no column ${check.unique_by}`;
        const seen = new Set();
        for (const cells of data) {
          const key = (cells[column] ?? "").toLowerCase();
          if (seen.has(key))
            return `${loaded.file.relative} repeats ${check.unique_by}=${cells[column]}`;
          seen.add(key);
        }
      }
      for (const wanted of check.contains_rows ?? []) {
        const hit = data.some((cells) =>
          wanted.every((value) => cells.includes(String(value))),
        );
        if (!hit)
          return `${loaded.file.relative} has no row with ${JSON.stringify(wanted)}`;
      }
      return undefined;
    },
    async json_valid(check, context) {
      const loaded = await text(context.directory, check);
      if (loaded.problem) return loaded.problem;
      let value;
      try {
        value = JSON.parse(loaded.text.replace(/^\uFEFF/, ""));
      } catch (error) {
        return `${loaded.file.relative} is not valid JSON: ${error.message}`;
      }
      for (const key of check.has_keys ?? [])
        if (!isObject(value) || !Object.hasOwn(value, key))
          return `${loaded.file.relative} has no key ${JSON.stringify(key)}`;
      if (check.subset !== undefined) {
        const problem = subsetProblem(value, check.subset, check.tolerance);
        if (problem) return `${loaded.file.relative}: ${problem}`;
      }
      return undefined;
    },
    async ics_valid(check, context) {
      const loaded = await text(context.directory, check);
      if (loaded.problem) return loaded.problem;
      const calendar = parseIcs(loaded.text);
      const name = loaded.file.relative;
      if (!calendar.calendar)
        return `${name} is not wrapped in BEGIN:VCALENDAR / END:VCALENDAR`;
      if (calendar.events.length < (check.min_events ?? 1))
        return `${name} has ${calendar.events.length} VEVENT block(s)`;
      const values = (event, key) =>
        (event.get(key) ?? []).map((item) => item.value);
      const fits = (event) => {
        if (!values(event, "DTSTART").length) return "VEVENT has no DTSTART";
        for (const [field, key] of [
          ["dtstart", "DTSTART"],
          ["dtend", "DTEND"],
        ]) {
          const wanted = list(check[field]);
          if (
            wanted.length &&
            !values(event, key).some((value) =>
              wanted.some((prefix) => value.startsWith(String(prefix))),
            )
          )
            return `${key} is ${JSON.stringify(values(event, key))}, expected one of ${JSON.stringify(wanted)}`;
        }
        for (const [field, key] of [
          ["summary_contains", "SUMMARY"],
          ["location_contains", "LOCATION"],
          ["description_contains", "DESCRIPTION"],
        ])
          if (
            check[field] !== undefined &&
            !values(event, key).some((value) =>
              squash(value).includes(squash(String(check[field]))),
            )
          )
            return `${key} is ${JSON.stringify(values(event, key))}, expected to contain ${JSON.stringify(check[field])}`;
        if (check.attendee_contains !== undefined) {
          const attendees = (event.get("ATTENDEE") ?? []).map((item) =>
            `${item.raw}:${item.value}`.toLowerCase(),
          );
          for (const wanted of list(check.attendee_contains))
            if (
              !attendees.some((value) =>
                value.includes(String(wanted).toLowerCase()),
              )
            )
              return `no ATTENDEE contains ${JSON.stringify(wanted)}`;
        }
        return undefined;
      };
      const problems = calendar.events.map(fits);
      return problems.some((problem) => problem === undefined)
        ? undefined
        : `${name}: ${problems[0]}`;
    },
    async eml_headers(check, context) {
      const loaded = await text(context.directory, check);
      if (loaded.problem) return loaded.problem;
      const message = parseEml(loaded.text);
      const name = loaded.file.relative;
      for (const [header, wanted] of Object.entries(check.headers ?? {})) {
        const actual = message.headers.get(header.toLowerCase());
        if (actual === undefined) return `${name} has no ${header} header`;
        if (
          !squash(actual.toLowerCase()).includes(
            squash(String(wanted).toLowerCase()),
          )
        )
          return `${name} ${header} is ${JSON.stringify(actual)}, expected to contain ${JSON.stringify(wanted)}`;
      }
      if (check.body_contains !== undefined || check.body_any !== undefined) {
        const problem = containsAll(
          message.text,
          { contains: check.body_contains, any: check.body_any },
          `${name} body`,
        );
        if (problem) return problem;
      }
      for (const wanted of list(check.attachment_names))
        if (
          !message.attachments.some(
            (file) => file.toLowerCase() === String(wanted).toLowerCase(),
          )
        )
          return `${name} has no attachment named ${wanted} (found ${JSON.stringify(message.attachments)})`;
      return undefined;
    },
    async zip_contains(check, context) {
      const loaded = await single(context.directory, check);
      if (loaded.problem) return loaded.problem;
      let archive;
      try {
        archive = readZip(loaded.bytes);
      } catch (error) {
        return `${loaded.file.relative}: ${error.message}`;
      }
      const names = archive.entries
        .filter((entry) => !entry.directory)
        .map((entry) => entry.name.toLowerCase());
      if (check.min_entries !== undefined && names.length < check.min_entries)
        return `${loaded.file.relative} has ${names.length} file(s), need ${check.min_entries}`;
      for (const wanted of list(check.entries)) {
        const target = String(wanted).replaceAll("\\", "/").toLowerCase();
        const hit = names.find(
          (name) => name === target || name.endsWith(`/${target}`),
        );
        if (!hit)
          return `${loaded.file.relative} has no entry ${wanted} (found ${JSON.stringify(names.slice(0, 20))})`;
        if (check.verify_data !== false)
          try {
            archive.read(
              archive.entries.find((entry) => entry.name.toLowerCase() === hit)
                .name,
            );
          } catch (error) {
            return `${loaded.file.relative}: ${error.message}`;
          }
      }
      return undefined;
    },
    async not_modified(check, context) {
      const key = String(check.path).replaceAll("\\", "/").toLowerCase();
      const before = context.baseline?.get(key);
      if (before === undefined)
        return `${check.path} was not part of the task setup`;
      const matches = (await findPaths(context.directory, check.path)).filter(
        (entry) => !entry.directory,
      );
      if (!matches.length) return `${check.path} was deleted`;
      return (await sha256(matches[0].absolute)) === before
        ? undefined
        : `${check.path} was modified`;
    },
    async process_running(check) {
      const names = list(check.names).map(processName);
      if (!names.length) return "process_running needs names";
      const wanted =
        check.command_line_contains === undefined
          ? undefined
          : list(check.command_line_contains).map((value) =>
              String(value).toLowerCase(),
            );
      const processes = await listProcesses({
        ...system,
        commandLines: wanted !== undefined,
      });
      const running = processes.filter((item) => names.includes(item.name));
      if (!running.length) return `none of ${names.join(", ")} is running`;
      if (
        wanted &&
        !running.some((item) =>
          wanted.every((value) =>
            (item.commandLine ?? "").toLowerCase().includes(value),
          ),
        )
      )
        return `${names.join(", ")} is running, but no command line contains ${JSON.stringify(wanted)}`;
      return undefined;
    },
    async window_title(check) {
      if (platform !== "win32")
        return "window_title is only supported on Windows";
      const result = await powershellJson(
        "$result = @{ items = @(Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { @{ pid = [int]$_.Id; name = [string]$_.ProcessName; title = [string]$_.MainWindowTitle } }) }",
        system,
      );
      const names = list(check.names).map(processName);
      const titles = list(result.items)
        .filter(
          (item) => !names.length || names.includes(processName(item.name)),
        )
        .map((item) => String(item.title));
      const wanted = list(check.contains).map((value) =>
        String(value).toLowerCase(),
      );
      return titles.some((title) =>
        wanted.some((value) => title.toLowerCase().includes(value)),
      )
        ? undefined
        : `no window title contains ${JSON.stringify(wanted)} (titles: ${JSON.stringify(titles.slice(0, 12))})`;
    },
    async shell_window(check) {
      if (platform !== "win32")
        return "shell_window is only supported on Windows";
      const result = await powershellJson(
        "$paths = @()\ntry { foreach ($window in (New-Object -ComObject Shell.Application).Windows()) { try { $paths += [string]$window.Document.Folder.Self.Path } catch { } } } catch { }\n$result = @{ items = @($paths) }",
        system,
      );
      const wanted = String(check.path_ends_with ?? "")
        .replaceAll("/", "\\")
        .replace(/\\+$/, "")
        .toLowerCase();
      const paths = list(result.items).map((item) =>
        String(item).replace(/\\+$/, "").toLowerCase(),
      );
      return paths.some((value) => value.endsWith(wanted))
        ? undefined
        : `no Explorer window shows a folder ending in ${JSON.stringify(wanted)} (open: ${JSON.stringify(paths.slice(0, 12))})`;
    },
    async reply_contains(check, context) {
      return containsAll(context.reply ?? "", check, "reply");
    },
    async reply_matches(check, context) {
      return new RegExp(check.pattern, check.flags ?? "i").test(
        context.reply ?? "",
      )
        ? undefined
        : `reply does not match /${check.pattern}/`;
    },
  };

  const verify = async (input, context) => {
    if (!isObject(input) || typeof input.kind !== "string")
      return {
        kind: "invalid",
        ok: false,
        summary: "check must be an object with a kind",
      };
    const check = expand(
      input,
      context.variables ?? checkVariables(context.directory),
    );
    if (check.kind === "any_of" || check.kind === "all_of") {
      const children = [];
      for (const child of list(check.checks))
        children.push(await verify(child, context));
      if (!children.length)
        return {
          kind: check.kind,
          ok: false,
          summary: `${check.kind} needs checks`,
        };
      const ok =
        check.kind === "any_of"
          ? children.some((child) => child.ok)
          : children.every((child) => child.ok);
      const failed = children.filter((child) => !child.ok);
      return {
        kind: check.kind,
        ok,
        summary: ok
          ? "ok"
          : failed
              .map((child) => child.summary)
              .join(check.kind === "any_of" ? " | " : "; "),
        children,
      };
    }
    if (check.kind === "not") {
      const child = await verify(check.check, context);
      return {
        kind: "not",
        ok: !child.ok,
        summary: child.ok ? `unexpectedly true: ${child.kind}` : "ok",
        children: [child],
      };
    }
    const handler = kinds[check.kind];
    if (!handler)
      return {
        kind: check.kind,
        ok: false,
        summary: `unknown check kind ${check.kind}`,
      };
    try {
      const problem = await handler(check, context);
      return {
        kind: check.kind,
        ok: problem === undefined,
        summary: problem ?? "ok",
      };
    } catch (error) {
      return {
        kind: check.kind,
        ok: false,
        summary: `check failed to run: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
  return verify;
}

/** Names of every supported check kind (for task-file validation). */
export const CHECK_KINDS = Object.freeze([
  "file_exists",
  "file_absent",
  "file_text_contains",
  "file_text_equals",
  "file_text_matches",
  "office_text_contains",
  "xlsx_cell",
  "xlsx_find",
  "csv_rows",
  "json_valid",
  "ics_valid",
  "eml_headers",
  "zip_contains",
  "not_modified",
  "process_running",
  "window_title",
  "shell_window",
  "reply_contains",
  "reply_matches",
  "any_of",
  "all_of",
  "not",
]);
