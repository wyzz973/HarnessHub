#!/usr/bin/env node
// G073: wording check of the interface (relay-architecture §12.4 "用词检查").
//
// The product calls the concept "Harness" in every word it shows (the user's decision of 2026-11-02, "改成harness"). This check
// parses the TypeScript sources of the web client (web/src) and of the Gateway's web server (src/web) with the TypeScript
// compiler API and reads every string that can reach a person: string literals, template text, JSX text and JSX attribute values
// (so the accessible names, aria-label and title, are covered like any label). A string that names the concept "Agent" is a
// violation, except in the fixed lists below. Comments, identifiers, module specifiers and types are not strings the interface
// shows, and are not read; nor are the search words of a command (`keywords`), which are matched and never shown.
//
// Usage: node tools/check-ui-wording.mjs [--root <dir>]
//   --root   directory to check; defaults to the repository this script belongs to. Fixtures run with their own root.
// Output: one line per violation on stdout, `<file>:<line> W1 <message>`, then a summary line. Exit codes: 0 nothing to report;
//   1 violations or integrity failures (W0: a file that does not parse, a scan root that is missing or has no sources);
//   2 unusable arguments or root. A required check that cannot run is a failure, never a pass.
//
// The exceptions are fixed lists, here and nowhere else: product names that contain "Agent" (Hermes Agent, Claude Agent) and
// the sub-agent a Harness runs (子 Agent); and the property whose value is a search word, not a word of the interface (the
// palette keeps the page's two old names, 我的 Agent and Agent, as search words so that they still find it, and a test holds
// it to that). Adding one is a decision: it is made in this file, with its reason.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";

const EXIT_VIOLATIONS = 1, EXIT_USAGE = 2;
const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The sources whose strings the interface shows: the web client, and the Gateway's own web server (its messages reach the page). */
const SCAN_ROOTS = ["web/src", "src/web"];
const EXTENSIONS = new Set([".ts", ".tsx"]);
const SKIP_DIRECTORIES = new Set(["node_modules", "dist"]);
/** The only places the word may stay. `Hermes Agent` and `Claude Agent` are product names; `子 Agent` is a Harness's own sub-agent. */
const EXCEPTIONS = Object.freeze(["Hermes Agent", "Claude Agent", "子 Agent"]);
/** Properties whose value is matched against what a person types and is never drawn: a command's search words. */
const SEARCH_WORDS = Object.freeze(["keywords"]);
/** The concept, as a word of its own: not part of an identifier, a path or a hyphenated name. */
const WORD = /(?<![A-Za-z0-9_-])Agents?(?![A-Za-z0-9_-])/gu;

class UsageError extends Error {}

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const MASKS = EXCEPTIONS.map(phrase => new RegExp("(?<![A-Za-z0-9_-])" + escape(phrase) + "(?![A-Za-z0-9_-])", "gu"));
/** The text with each exception blanked out, same length, so a match keeps its place. */
const mask = text => MASKS.reduce((rest, pattern) => rest.replace(pattern, found => " ".repeat(found.length)), text);

const scriptKindOf = file => file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
/** The syntax errors of a file; a tree that does not parse cannot be trusted, so no string of it is read. */
function syntaxErrors(file, text) {
  const output = ts.transpileModule(text, { fileName: file, reportDiagnostics: true, compilerOptions: { noLib: true, noResolve: true, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.Preserve } });
  return (output.diagnostics ?? []).map(diagnostic => ({
    line: diagnostic.file !== undefined && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : 1,
    text: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
  }));
}

/** Every string of a file that can reach a person, with the line it starts on. JSX text is kept as written, so a match in it has an exact line. */
function interfaceStrings(sf) {
  const found = [];
  const visit = node => {
    // What is named by a module is not shown: import and export specifiers, import() and require().
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      for (const argument of node.arguments.slice(1)) visit(argument);
      return;
    }
    // A string in a type (`"agent" | "task"`) names a case of the code, not a word of the interface.
    if (ts.isLiteralTypeNode(node)) return;
    // A search word is matched and never drawn.
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && SEARCH_WORDS.includes(node.name.text)) return;
    if (ts.isJsxText(node)) found.push({ text: node.text, jsx: true, start: node.pos });
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      found.push({ text: node.text, jsx: false, start: node.getStart(sf) });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function analyze(root, file, out) {
  const text = readFileSync(path.join(root, file), "utf8");
  const syntax = syntaxErrors(file, text);
  if (syntax.length > 0) {
    for (const error of syntax.slice(0, 3)) out.push({ file, line: error.line, rule: "W0", message: `does not parse (${error.text}); no string of this file could be checked` });
    return 0;
  }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const strings = interfaceStrings(sf);
  for (const item of strings) {
    const shown = mask(item.text);
    for (const match of shown.matchAll(WORD)) {
      const line = sf.getLineAndCharacterOfPosition(item.start).line + 1 + (item.jsx ? item.text.slice(0, match.index).split("\n").length - 1 : 0);
      const excerpt = shown.slice(Math.max(0, match.index - 12), match.index + match[0].length + 12).replace(/\s+/gu, " ").trim();
      out.push({ file, line, rule: "W1", message: `the interface names the concept "${match[0]}" (…${excerpt}…); it says "Harness" (allowed: ${EXCEPTIONS.join(", ")})` });
    }
  }
  return strings.length;
}

function walk(root, directory, files) {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const relative = directory + "/" + entry.name;
    if (entry.isDirectory()) { if (!SKIP_DIRECTORIES.has(entry.name)) walk(root, relative, files); }
    else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) files.push(relative);
  }
}

/** Runs the check and returns the exit code. Throws UsageError for arguments or a root that cannot be used. */
function main(argv) {
  let options;
  try { options = parseArgs({ args: argv, options: { root: { type: "string" }, help: { type: "boolean", short: "h" } }, strict: true, allowPositionals: false }).values; }
  catch (error) { throw new UsageError(error instanceof Error ? error.message : String(error)); }
  if (options.help) { process.stdout.write("usage: node tools/check-ui-wording.mjs [--root <dir>]\n"); return 0; }
  const root = path.resolve(options.root ?? SELF_ROOT);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new UsageError(`root ${root} is not a directory, so nothing was scanned`);

  const problems = [], files = [];
  for (const scanRoot of SCAN_ROOTS) {
    if (!existsSync(path.join(root, scanRoot)) || !statSync(path.join(root, scanRoot)).isDirectory()) { problems.push({ file: scanRoot, line: 1, rule: "W0", message: `scan root ${scanRoot} does not exist, so its strings could not be checked` }); continue; }
    const before = files.length;
    walk(root, scanRoot, files);
    if (files.length === before) problems.push({ file: scanRoot, line: 1, rule: "W0", message: `scan root ${scanRoot} has no ${[...EXTENSIONS].join("/")} sources, so its strings could not be checked` });
  }
  let strings = 0;
  for (const file of files) {
    try { strings += analyze(root, file, problems); }
    catch (error) { problems.push({ file, line: 1, rule: "W0", message: `the analysis failed (${error instanceof Error ? error.message : String(error)}); no string of this file could be checked` }); }
  }
  for (const item of problems) process.stdout.write(`${item.file}:${item.line} ${item.rule} ${item.message}\n`);
  process.stdout.write(`ui-wording: ${files.length} files, ${strings} strings, ${problems.length} problem(s)\n`);
  return problems.length === 0 ? 0 : EXIT_VIOLATIONS;
}

try { process.exitCode = main(process.argv.slice(2)); }
catch (error) {
  if (!(error instanceof UsageError)) throw error;
  process.stderr.write(`check-ui-wording: ${error.message}\n`);
  process.exitCode = EXIT_USAGE;
}
