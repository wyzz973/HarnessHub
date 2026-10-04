#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Small offline check for this repository's Markdown, not a CommonMark parser.
 * Usage: node tools/check-docs.mjs [--root <directory>]
 *
 * Checks .md/.markdown files recursively, except GENERATED_DIRECTORIES below.
 * A document that is empty or holds only whitespace fails: it is almost always
 * an accidental truncation, which the other checks would accept.
 * Supports top-level fences (0-3 spaces, backticks or tildes), matching backtick
 * code spans, and single-line inline links/images: [label](path) and angle
 * destinations with spaces, with optional quoted titles. URL-encoded destinations and
 * backslash-escaped Markdown punctuation are decoded. Paths are relative to
 * the containing document; absolute filesystem paths are rejected.
 * Existing symlinks must also resolve inside root. In-root symlink directories
 * are visited once, so cycles cannot recurse forever.
 *
 * Lines indented by four spaces or a tab are treated as code examples.
 * A `#fragment` of a link to a Markdown file (or of a link within one) must
 * name a heading of that file, by GitHub's slugs (lowercase, punctuation and
 * symbols removed, CJK kept, spaces to hyphens, `-1`, `-2` for repeated
 * headings), or an explicit `<a id>`/`<a name>` anchor; fragments of links
 * to other files (source line anchors, JSON) are not checked. Headings are
 * ATX and setext headings outside code.
 * Does not validate remote URLs, reference links, autolinks, other HTML,
 * or Markdown container grammar (e.g. list indentation and quoted fences).
 * URI schemes and protocol-relative URLs are ignored except file: URLs, which
 * are rejected in favor of portable relative paths. No network requests occur.
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERATED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', 'data', 'artifacts',
  '.cache', '.next', 'out', 'tmp', '.tmp', '.tools', 'temp', 'runtime-data', '.worktrees',
]);
const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));

function withinRoot(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function escaped(text, index) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

function maskCode(text, report) {
  let fence;
  const lines = text.split('\n');
  const masked = lines.map((line, index) => {
    if (fence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) {
        fence = undefined;
      }
      return blank(line);
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = { char: opening[1][0], length: opening[1].length, line: index + 1 };
      return blank(line);
    }
    return /^( {4}|\t)/.test(line) ? blank(line) : line;
  }).join('\n');
  if (fence) report(fence.line, 'unclosed fenced code block');

  // Mask only matched runs of exactly equal length; unmatched backticks are text.
  const result = masked.split('');
  const runs = [...masked.matchAll(/`+/g)];
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i];
    if (escaped(masked, open.index)) continue;
    let closeIndex = i + 1;
    while (closeIndex < runs.length && runs[closeIndex][0].length !== open[0].length) closeIndex++;
    if (closeIndex === runs.length) continue;
    const end = runs[closeIndex].index + runs[closeIndex][0].length;
    for (let j = open.index; j < end; j++) if (result[j] !== '\n') result[j] = ' ';
    i = closeIndex;
  }
  return result.join('');
}

/**
 * The text a heading renders to: code spans, links and images by their
 * text, emphasis and HTML tags dropped.
 */
function headingText(markdown) {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`/g, '')
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, '$1');
}

/** GitHub's slug of a heading's text, before duplicates are numbered. */
export function headingSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/**
 * The anchors of a document: its headings' slugs, numbered `-1`, `-2` …
 * when repeated as GitHub numbers them, and the ids and names of its `<a>`
 * tags. `visible` is the text with its code masked (maskCode): a heading
 * is read from the original line, code spans included, where the masked
 * line is not code; tags count outside code only.
 */
export function documentAnchors(text, visible) {
  const original = text.split('\n');
  const anchors = new Set();
  const occurrences = new Map();
  const add = (base) => {
    let slug = base;
    while (occurrences.has(slug)) {
      const count = occurrences.get(base) + 1;
      occurrences.set(base, count);
      slug = `${base}-${count}`;
    }
    occurrences.set(slug, 0);
    anchors.add(slug);
  };
  const lines = visible.split('\n');
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    const atx = original[index].match(/^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/);
    if (atx) add(headingSlug(headingText(atx[1] ?? '')));
    const previous = lines[index - 1];
    if (
      /^ {0,3}(?:=+|-+)[ \t]*$/.test(line) &&
      previous !== undefined &&
      previous.trim() !== '' &&
      !/^ {0,3}(?:#|>|[-*+][ \t]|\d+[.)][ \t]|\||(?:=+|-+)[ \t]*$)/.test(previous)
    )
      add(headingSlug(headingText(original[index - 1].trim())));
    for (const tag of line.matchAll(/<a\s[^>]*>/gi))
      for (const attribute of tag[0].matchAll(/\s(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi))
        anchors.add(attribute[1] ?? attribute[2] ?? attribute[3]);
  });
  return anchors;
}

function inlineLinks(line) {
  const links = [];
  for (let start = 0; start < line.length; start++) {
    if (line[start] !== '[' || escaped(line, start)) continue;
    let cursor = start + 1;
    let depth = 1;
    for (; cursor < line.length && depth; cursor++) {
      if (escaped(line, cursor)) continue;
      if (line[cursor] === '[') depth++;
      if (line[cursor] === ']') depth--;
    }
    if (depth || line[cursor] !== '(') continue;
    cursor++;
    while (/[ \t]/.test(line[cursor] ?? 'x')) cursor++;
    const destinationStart = cursor;
    let destination;
    if (line[cursor] === '<') {
      cursor++;
      while (cursor < line.length && (line[cursor] !== '>' || escaped(line, cursor))) cursor++;
      if (cursor === line.length) continue;
      destination = line.slice(destinationStart + 1, cursor++);
    } else {
      let parentheses = 0;
      for (; cursor < line.length; cursor++) {
        if (escaped(line, cursor)) continue;
        if (line[cursor] === '(') parentheses++;
        if (line[cursor] === ')') {
          if (!parentheses) break;
          parentheses--;
        }
        if (/[ \t]/.test(line[cursor])) break;
      }
      if (parentheses) continue;
      destination = line.slice(destinationStart, cursor);
    }
    const suffix = line.slice(cursor).match(/^[ \t]*(?:(?:"[^"\n]*"|'[^'\n]*')[ \t]*)?\)/);
    if (!suffix) continue;
    links.push(destination);
    start = cursor + suffix[0].length - 1;
  }
  return links;
}

/**
 * Read project Markdown and collect offline validation diagnostics without writes.
 *
 * @param {string} [rootDirectory] Existing project directory. Defaults to the
 *   repository containing this script, regardless of the caller's cwd.
 * @returns {Promise<{checkedFiles: number, diagnostics: string[]}>} Discovered
 *   Markdown count and file:line diagnostics. An empty inventory is an error.
 * @throws {Error} Rejects if project resolution, directory enumeration, or
 *   document reads fail. Link-target and symlink inspection failures become
 *   diagnostics. The CLI turns either kind of failure into a nonzero exit.
 */
export async function checkDocs(rootDirectory = DEFAULT_ROOT) {
  const diagnostics = [];
  const files = [];
  const root = await realpath(path.resolve(rootDirectory));
  const display = (file) => path.relative(root, file).split(path.sep).join('/') || '.';
  const report = (file, line, message) => diagnostics.push(`${display(file)}:${line}: ${message}`);
  const visited = new Set();
  /** The anchors of each Markdown file read, by real path. */
  const anchors = new Map();
  const anchorsOf = async (file) => {
    const real = await realpath(file);
    if (!anchors.has(real)) {
      const text = (await readFile(real, 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
      anchors.set(real, documentAnchors(text, maskCode(text, () => {})));
    }
    return anchors.get(real);
  };

  async function walk(directory) {
    const resolved = await realpath(directory);
    if (!withinRoot(root, resolved)) {
      report(directory, 1, 'symlink escapes project root');
      return;
    }
    if (visited.has(resolved)) return;
    visited.add(resolved);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (GENERATED_DIRECTORIES.has(entry.name)) continue;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isSymbolicLink()) {
        // Directory symlinks are uncommon, but handle cycles and escapes explicitly.
        try {
          if ((await stat(file)).isDirectory()) await walk(file);
          else if (/\.(md|markdown)$/i.test(entry.name)) files.push(file);
        } catch (error) {
          report(file, 1, `cannot inspect symlink: ${error.code ?? error.message}`);
        }
      } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) files.push(file);
    }
  }
  /** Reports a link's fragment that names no anchor of the Markdown file `target`. */
  async function checkAnchor(file, line, target, fragment, raw) {
    let anchor;
    try {
      anchor = decodeURIComponent(fragment);
    } catch {
      report(file, line, `invalid URL encoding in anchor: ${raw}`);
      return;
    }
    if (!anchor) return;
    if (!(await anchorsOf(target)).has(anchor))
      report(file, line, `no heading or anchor #${anchor} in ${display(target)}: ${raw}`);
  }

  await walk(root);
  if (!files.length) report(root, 1, 'no Markdown files found; nothing was checked');

  for (const file of files) {
    if (!withinRoot(root, await realpath(file))) {
      report(file, 1, 'Markdown symlink escapes project root');
      continue;
    }
    const bytes = await readFile(file);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      report(file, 1, 'invalid UTF-8');
      continue;
    }
    if (text.trim() === '') {
      report(file, 1, 'document is empty or holds only whitespace');
      continue;
    }
    if (text.startsWith('\uFEFF')) report(file, 1, 'UTF-8 BOM is not allowed');
    const carriageReturn = text.indexOf('\r');
    if (carriageReturn !== -1) report(file, lineAt(text, carriageReturn), 'use LF line endings, not CRLF or CR');
    if (!text.endsWith('\n') || text.endsWith('\n\n')) {
      report(file, text.split('\n').length, 'expected exactly one final LF newline');
    }

    // Normalize only for parsing, after recording encoding/style errors above.
    const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const visible = maskCode(normalized, (line, message) => report(file, line, message));
    anchors.set(await realpath(file), documentAnchors(normalized, visible));
    for (const [index, line] of visible.split('\n').entries()) {
      for (const raw of inlineLinks(line)) {
        const destination = raw.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1');
        if (!destination || destination.startsWith('//')) continue;
        if (destination.startsWith('#')) {
          await checkAnchor(file, index + 1, file, destination.slice(1), raw);
          continue;
        }
        if (/^file:/i.test(destination)) {
          report(file, index + 1, 'file: links are unsupported; use a relative path');
          continue;
        }
        if (/^[a-z]:[\\/]/i.test(destination)) {
          report(file, index + 1, 'Windows absolute links are unsupported; use a relative path');
          continue;
        }
        if (/^[a-z][a-z\d+.-]*:/i.test(destination)) continue;
        let local;
        try {
          local = decodeURIComponent(destination.split(/[?#]/, 1)[0]);
        } catch {
          report(file, index + 1, `invalid URL encoding in local link: ${raw}`);
          continue;
        }
        if (!local) continue;
        if (path.posix.isAbsolute(local) || path.win32.isAbsolute(local)) {
          report(file, index + 1, 'absolute local links are unsupported; use a relative path');
          continue;
        }
        const target = path.resolve(path.dirname(file), local);
        if (!withinRoot(root, target)) {
          report(file, index + 1, `local link escapes project root: ${raw}`);
          continue;
        }
        try {
          if (!withinRoot(root, await realpath(target))) {
            report(file, index + 1, `local link symlink escapes project root: ${raw}`);
            continue;
          }
        } catch (error) {
          report(file, index + 1, `local link target unavailable (${error.code ?? error.message}): ${raw}`);
          continue;
        }
        const hash = destination.indexOf('#');
        if (hash !== -1 && /\.(md|markdown)$/i.test(local) && (await stat(target)).isFile())
          await checkAnchor(file, index + 1, target, destination.slice(hash + 1), raw);
      }
    }
  }
  return { checkedFiles: files.length, diagnostics };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--root' || !args[1])) {
    console.error('Usage: node tools/check-docs.mjs [--root <directory>]');
    process.exitCode = 2;
  } else {
    try {
      const result = await checkDocs(args[1] ?? DEFAULT_ROOT);
      if (result.diagnostics.length) {
        console.error(result.diagnostics.join('\n'));
        process.exitCode = 1;
      } else {
        console.log(`Docs check passed: ${result.checkedFiles} Markdown files (offline checks only).`);
      }
    } catch (error) {
      console.error(`.:1: document check could not complete: ${error.code ?? error.message}`);
      process.exitCode = 1;
    }
  }
}
