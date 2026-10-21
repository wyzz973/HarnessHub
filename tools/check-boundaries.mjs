#!/usr/bin/env node
// G063: dependency and test-isolation boundary check.
//
// Parses the TypeScript sources of the gateway (src), the web client (web/src) and the tests with the TypeScript compiler
// API, applies the rules of tools/boundary-rules.json and prints every violation as `<file>:<line> <rule-id> <message>` on
// stdout. The rule file is the only place where rules and registered exceptions live; this script only interprets it.
//
// Usage: node tools/check-boundaries.mjs [--root <dir>] [--rules <file>]
//   --root   directory to check; defaults to the repository this script belongs to. Fixtures run with their own root.
//   --rules  rule file; defaults to tools/boundary-rules.json next to this script.
// Exit codes: 0 nothing to report; 1 violations or integrity failures (B0: a file that does not parse, a scan root that is
//   missing or empty, an import that cannot be classified, an exception that no longer matches anything); 2 unusable
//   arguments, root or rule file. A required check that cannot run is a failure, never a pass.
//
// The analysis is static and per file. It sees import / export ... from / import() / require() / import type, and in tests
// the options of the `application(` and `startWebServer(` calls and the arguments of the processes that start the official
// commands. It does not follow values across files, and it does not read `/// <reference>` directives, path strings built
// for `new URL(..., import.meta.url)` or the .mjs fixtures. What it cannot classify is reported, not skipped.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";

const EXIT_VIOLATIONS = 1, EXIT_USAGE = 2;
const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Modules Node resolves without the `node:` prefix; the ones that exist only with the prefix are not in this set. */
const BARE_BUILTINS = new Set(builtinModules.filter(name => !name.startsWith("node:")));
/** How deep values are followed through variables, helper functions and parameters before the analysis gives up. */
const MAX_DEPTH = 16;

class UsageError extends Error {}

// ---------------------------------------------------------------------------------------------------------------------
// Rule file
// ---------------------------------------------------------------------------------------------------------------------

/** Compiles a path pattern: `*` is one segment, `**` is any number of segments (also none), anything else is literal. */
function globMatcher(pattern, where) {
  const segments = pattern.split("/");
  if (pattern === "" || segments.some(segment => segment === "" || segment === ".." || (segment.includes("*") && segment !== "*" && segment !== "**")))
    throw new UsageError(`${where}: invalid path pattern "${pattern}"`);
  const match = (p, target, t) => {
    if (p === segments.length) return t === target.length;
    if (segments[p] === "**") {
      for (let skip = t; skip <= target.length; skip++) if (match(p + 1, target, skip)) return true;
      return false;
    }
    return t < target.length && (segments[p] === "*" || segments[p] === target[t]) && match(p + 1, target, t + 1);
  };
  return { pattern, test: value => match(0, value.split("/"), 0) };
}
const anyMatch = (matchers, value) => matchers.some(matcher => matcher.test(value));

function objectOf(value, where, fields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new UsageError(`${where}: expected an object`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new UsageError(`${where}: unknown field "${key}"`);
  return value;
}
function textOf(value, where) {
  if (typeof value !== "string" || value.trim() === "") throw new UsageError(`${where}: expected a non-empty string`);
  return value;
}
function listOf(value, where, item = textOf, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) throw new UsageError(`${where}: expected ${nonEmpty ? "a non-empty " : "an "}array`);
  return value.map((entry, index) => item(entry, `${where}[${index}]`));
}
const globsOf = (value, where, options) => listOf(value, where, (entry, at) => globMatcher(textOf(entry, at), at), options);
function nodeModuleOf(value, where) {
  const text = textOf(value, where);
  if (!/^node:[a-z_][a-z0-9_]*$/u.test(text)) throw new UsageError(`${where}: expected node:<module> without a sub-path, got "${text}"`);
  return text.slice("node:".length);
}

function exceptionsOf(value, where, kind) {
  return listOf(value ?? [], where, (entry, at) => {
    const fields = kind === "imports" || kind === "isolated" ? ["file", "key", "typeOnly", "count", "reason"] : ["file", "key", "count", "reason"];
    const item = objectOf(entry, at, fields);
    const count = item.count ?? 1;
    if (!Number.isInteger(count) || count < 1) throw new UsageError(`${at}.count: expected a positive integer`);
    if (item.typeOnly !== undefined && typeof item.typeOnly !== "boolean") throw new UsageError(`${at}.typeOnly: expected a boolean`);
    return { file: textOf(item.file, `${at}.file`), key: textOf(item.key, `${at}.key`), typeOnly: item.typeOnly, count, reason: textOf(item.reason, `${at}.reason`), used: 0 };
  });
}

/** Reads and validates the rule file. Every problem is a UsageError naming the field; nothing is defaulted silently. */
function loadRules(file) {
  let raw;
  try { raw = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { throw new UsageError(`cannot read rule file ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  const top = objectOf(raw, file, ["version", "description", "scan", "rules"]);
  if (top.version !== 1) throw new UsageError(`${file}: unsupported version ${JSON.stringify(top.version)}`);
  textOf(top.description, `${file}.description`);
  const scan = objectOf(top.scan, `${file}.scan`, ["roots", "extensions", "skipDirectories"]);
  const rules = [], ids = new Set();
  listOf(top.rules, `${file}.rules`, (entry, at) => {
    const base = objectOf(entry, at, ["id", "title", "kind", "appliesTo", "exceptions", "node", "packages", "paths", "groups", "calls", "entries", "spawners", "requiredFlag", "pairs", "exemptFlags"]);
    const id = textOf(base.id, `${at}.id`);
    if (!/^B[1-9][0-9]*$/u.test(id) || ids.has(id)) throw new UsageError(`${at}.id: "${id}" is not a unique rule id of the form B<n> (B0 is the check's own integrity rule)`);
    ids.add(id);
    const rule = { id, title: textOf(base.title, `${at}.title`), kind: textOf(base.kind, `${at}.kind`), appliesTo: globsOf(base.appliesTo, `${at}.appliesTo`, { nonEmpty: true }) };
    const only = (...fields) => { for (const key of Object.keys(base)) if (!["id", "title", "kind", "appliesTo", "exceptions", ...fields].includes(key)) throw new UsageError(`${at}: field "${key}" does not belong to a ${rule.kind} rule`); };
    if (rule.kind === "imports") {
      only("node", "packages", "paths");
      const nodeRule = base.node === undefined ? null : objectOf(base.node, `${at}.node`, ["allow", "deny"]);
      if (nodeRule !== null && (nodeRule.allow === undefined) === (nodeRule.deny === undefined)) throw new UsageError(`${at}.node: give exactly one of allow and deny`);
      rule.node = nodeRule === null ? null : nodeRule.allow !== undefined
        ? { mode: "allow", names: new Set(listOf(nodeRule.allow, `${at}.node.allow`, nodeModuleOf)) }
        : { mode: "deny", names: new Set(listOf(nodeRule.deny, `${at}.node.deny`, nodeModuleOf, { nonEmpty: true })) };
      const packages = base.packages === undefined ? null : objectOf(base.packages, `${at}.packages`, ["allow", "inPaths"]);
      rule.packages = packages === null ? null : { allow: new Set(listOf(packages.allow, `${at}.packages.allow`)), inPaths: packages.inPaths === undefined ? null : globsOf(packages.inPaths, `${at}.packages.inPaths`, { nonEmpty: true }) };
      const paths = base.paths === undefined ? null : objectOf(base.paths, `${at}.paths`, ["allow", "deny"]);
      if (paths !== null && paths.allow === undefined && paths.deny === undefined) throw new UsageError(`${at}.paths: give allow, deny or both`);
      rule.paths = paths === null ? null : { allow: paths.allow === undefined ? null : globsOf(paths.allow, `${at}.paths.allow`, { nonEmpty: true }), deny: paths.deny === undefined ? null : globsOf(paths.deny, `${at}.paths.deny`, { nonEmpty: true }) };
      if (rule.node === null && rule.packages === null && rule.paths === null) throw new UsageError(`${at}: an imports rule needs node, packages or paths`);
    } else if (rule.kind === "isolated") {
      only("groups");
      rule.groups = globMatcher(textOf(base.groups, `${at}.groups`), `${at}.groups`).pattern.split("/");
      if (rule.groups.some(segment => segment === "**")) throw new UsageError(`${at}.groups: ** is not allowed`);
    } else if (rule.kind === "call-options") {
      only("calls");
      rule.calls = listOf(base.calls, `${at}.calls`, (call, inner) => {
        const item = objectOf(call, inner, ["callee", "argument", "anyOf"]);
        if (!Number.isInteger(item.argument) || item.argument < 0) throw new UsageError(`${inner}.argument: expected a zero-based argument index`);
        return { callee: textOf(item.callee, `${inner}.callee`), argument: item.argument, anyOf: listOf(item.anyOf, `${inner}.anyOf`, textOf, { nonEmpty: true }) };
      }, { nonEmpty: true });
    } else if (rule.kind === "spawn-flags") {
      only("entries", "spawners", "requiredFlag", "pairs", "exemptFlags");
      rule.entries = listOf(base.entries, `${at}.entries`, textOf, { nonEmpty: true });
      rule.spawners = new Set(listOf(base.spawners, `${at}.spawners`, textOf, { nonEmpty: true }));
      rule.requiredFlag = textOf(base.requiredFlag, `${at}.requiredFlag`);
      rule.pairs = listOf(base.pairs, `${at}.pairs`, (pair, inner) => {
        const item = objectOf(pair, inner, ["when", "requires"]);
        return { when: textOf(item.when, `${inner}.when`), requires: textOf(item.requires, `${inner}.requires`) };
      });
      rule.exemptFlags = listOf(base.exemptFlags, `${at}.exemptFlags`);
    } else throw new UsageError(`${at}.kind: unknown rule kind "${rule.kind}"`);
    rule.exceptions = exceptionsOf(base.exceptions, `${at}.exceptions`, rule.kind);
    rules.push(rule);
    return rule;
  }, { nonEmpty: true });
  return {
    scan: {
      roots: listOf(scan.roots, `${file}.scan.roots`, (entry, at) => {
        const text = textOf(entry, at);
        if (text.startsWith("/") || text.split("/").includes("..") || text.endsWith("/")) throw new UsageError(`${at}: expected a relative directory without a trailing slash`);
        return text;
      }, { nonEmpty: true }),
      extensions: listOf(scan.extensions, `${file}.scan.extensions`, (entry, at) => {
        if (!/^\.[a-z]+$/u.test(textOf(entry, at))) throw new UsageError(`${at}: expected an extension like .ts`);
        return entry;
      }, { nonEmpty: true }),
      skipDirectories: listOf(scan.skipDirectories, `${file}.scan.skipDirectories`),
    },
    rules,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Finding the files to scan
// ---------------------------------------------------------------------------------------------------------------------

function walk(root, relative, extensions, skip, out) {
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) { if (!skip.has(entry.name)) walk(root, child, extensions, skip, out); }
    else if (extensions.has(path.extname(entry.name)) && statSync(path.join(root, child)).isFile()) out.push(child);
  }
}

/**
 * The sources under the scan roots: what git lists as tracked or not ignored when the root is a git work tree, otherwise a
 * walk that skips the configured directories. A file git lists but that is gone from the work tree is skipped (it has no
 * imports); a root that does not exist or yields no source at all is an integrity failure, not an empty pass.
 */
function discover(root, scan, problems) {
  const extensions = new Set(scan.extensions), skip = new Set(scan.skipDirectories);
  let via = "walk", listed = null;
  if (existsSync(path.join(root, ".git"))) {
    try {
      listed = execFileSync("git", ["-C", root, "ls-files", "-z", "-co", "--exclude-standard", "--", ...scan.roots], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
        .split("\0").filter(name => name !== "" && extensions.has(path.extname(name)) && !name.split("/").some(part => skip.has(part)) && existsSync(path.join(root, name)) && statSync(path.join(root, name)).isFile());
      via = "git";
    } catch (error) {
      process.stderr.write(`check-boundaries: git could not list the files (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); walking the file system instead\n`);
    }
  }
  const files = listed ?? [];
  if (listed === null) for (const scanRoot of scan.roots) {
    if (existsSync(path.join(root, scanRoot)) && statSync(path.join(root, scanRoot)).isDirectory()) walk(root, scanRoot, extensions, skip, files);
  }
  const counts = new Map(scan.roots.map(scanRoot => [scanRoot, 0]));
  for (const file of files) for (const scanRoot of scan.roots) if (file.startsWith(scanRoot + "/")) counts.set(scanRoot, counts.get(scanRoot) + 1);
  for (const [scanRoot, count] of counts) {
    if (!existsSync(path.join(root, scanRoot)) || !statSync(path.join(root, scanRoot)).isDirectory())
      problems.push(integrity(scanRoot, 1, "scan-root", `scan root ${scanRoot} does not exist, so none of its rules could be checked`));
    else if (count === 0)
      problems.push(integrity(scanRoot, 1, "scan-root", `scan root ${scanRoot} has no ${scan.extensions.join("/")} sources${via === "git" ? " known to git (is the directory ignored?)" : ""}, so none of its rules could be checked`));
  }
  return { via, files: [...new Set(files)].sort(), counts };
}

// ---------------------------------------------------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------------------------------------------------

const violation = (file, line, rule, key, message, extra = {}) => ({ file, line, rule, key, message, ...extra });
const integrity = (file, line, key, message) => violation(file, line, "B0", key, message);

// ---------------------------------------------------------------------------------------------------------------------
// Parsing and import edges
// ---------------------------------------------------------------------------------------------------------------------

const scriptKindOf = file => file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

/** The syntax errors the TypeScript parser reports for one file, as `{ line, text }`. */
function syntaxErrors(file, text) {
  const output = ts.transpileModule(text, { fileName: file, reportDiagnostics: true, compilerOptions: { noLib: true, noResolve: true, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.Preserve } });
  return (output.diagnostics ?? []).map(diagnostic => ({
    line: diagnostic.file !== undefined && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : 1,
    text: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
  }));
}

/**
 * Every module reference in the file: import declarations, export ... from, import x = require(), import() and require()
 * calls, and import("...") type nodes. `typeOnly` is true only where nothing is loaded at run time: `import type`,
 * `export type ... from` and import types. `import { type A }` is not type-only: under verbatimModuleSyntax it still
 * loads the module. References whose specifier is not a string literal are returned as `unclassified`.
 */
function moduleReferences(sf) {
  const edges = [], unclassified = [];
  const lineOf = node => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) edges.push({ specifier: node.moduleSpecifier.text, line: lineOf(node), typeOnly: node.importClause?.isTypeOnly === true, form: "import" });
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) edges.push({ specifier: node.moduleSpecifier.text, line: lineOf(node), typeOnly: node.isTypeOnly, form: "export" });
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (ts.isStringLiteralLike(node.moduleReference.expression)) edges.push({ specifier: node.moduleReference.expression.text, line: lineOf(node), typeOnly: node.isTypeOnly, form: "require" });
      else unclassified.push({ line: lineOf(node), form: "require" });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length > 0))) {
      const form = node.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic import" : "require";
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteralLike(argument)) edges.push({ specifier: argument.text, line: lineOf(node), typeOnly: false, form });
      else unclassified.push({ line: lineOf(node), form });
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) edges.push({ specifier: node.argument.literal.text, line: lineOf(node), typeOnly: true, form: "import type" });
      else unclassified.push({ line: lineOf(node), form: "import type" });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { edges, unclassified };
}

/**
 * What a specifier points at, seen from the importing file: a repository path (relative imports, resolved to a path from the
 * root, extension as written), a Node built-in (base name, `fs` for `node:fs/promises`), a package name, or something this
 * check cannot place (a path outside the root, an absolute path, a URL, a `#` import).
 */
function classify(specifier, importer) {
  if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier.replace(/[?#].*$/u, "")));
    return resolved === ".." || resolved.startsWith("../") ? { kind: "outside" } : { kind: "path", path: resolved };
  }
  if (specifier.startsWith("node:")) return { kind: "builtin", base: specifier.slice("node:".length).split("/")[0] };
  if (BARE_BUILTINS.has(specifier)) return { kind: "builtin", base: specifier.split("/")[0] };
  if (specifier.startsWith("/") || specifier.startsWith("#") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier)) return { kind: "other" };
  const parts = specifier.split("/");
  return { kind: "package", name: specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Import rules
// ---------------------------------------------------------------------------------------------------------------------

function importProblem(rule, file, target) {
  if (target.kind === "builtin" && rule.node !== null) {
    const listed = rule.node.names.has(target.base);
    if (rule.node.mode === "allow" && !listed) {
      const names = [...rule.node.names].map(name => "node:" + name);
      return { key: "node:" + target.base, message: `imports node:${target.base}, which this layer may not use (node modules allowed here: ${names.length === 0 ? "none" : names.join(", ")})` };
    }
    if (rule.node.mode === "deny" && listed) return { key: "node:" + target.base, message: `imports node:${target.base}, which this layer must not use` };
  }
  if (target.kind === "package" && rule.packages !== null) {
    if (rule.packages.inPaths !== null && !anyMatch(rule.packages.inPaths, file))
      return { key: target.name, message: `imports package ${target.name}; third-party packages are only allowed in ${rule.packages.inPaths.map(matcher => matcher.pattern).join(", ")}` };
    if (!rule.packages.allow.has(target.name)) {
      const names = [...rule.packages.allow];
      return { key: target.name, message: `imports package ${target.name}, which is not an allowed third-party package here (${names.length === 0 ? "none are allowed" : "allowed: " + names.join(", ")})` };
    }
  }
  if (target.kind === "path" && rule.paths !== null) {
    if (rule.paths.allow !== null && !anyMatch(rule.paths.allow, target.path))
      return { key: target.path, message: `imports ${target.path}, outside what this layer may depend on (${rule.paths.allow.map(matcher => matcher.pattern).join(", ")})` };
    if (rule.paths.deny !== null && anyMatch(rule.paths.deny, target.path))
      return { key: target.path, message: `imports ${target.path}, which this layer must not depend on (${rule.paths.deny.map(matcher => matcher.pattern).join(", ")})` };
  }
  return null;
}

/** The group a path belongs to under a groups pattern such as src/contexts/*, or null when it is outside every group. */
function groupOf(pattern, value) {
  const parts = value.split("/");
  if (parts.length <= pattern.length) return null;
  return pattern.every((segment, index) => segment === "*" || segment === parts[index]) ? parts.slice(0, pattern.length).join("/") : null;
}

function checkImportRules(rules, file, references, out) {
  for (const edge of references) {
    const target = classify(edge.specifier, file);
    for (const rule of rules) {
      if (!anyMatch(rule.appliesTo, file)) continue;
      let problem = null;
      if (rule.kind === "imports") problem = importProblem(rule, file, target);
      else if (rule.kind === "isolated" && target.kind === "path") {
        const own = groupOf(rule.groups, file), other = groupOf(rule.groups, target.path);
        if (own !== null && other !== null && own !== other) problem = { key: target.path, message: `imports ${target.path} from ${other}, but ${own} may not depend on another context` };
      }
      if (problem !== null) out.push(violation(file, edge.line, rule.id, problem.key, `${problem.message}${edge.typeOnly ? " (import type)" : ""} — ${rule.title}`, { typeOnly: edge.typeOnly }));
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Scopes and values (for the call rules)
// ---------------------------------------------------------------------------------------------------------------------

const unwrap = node => {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression;
  return node;
};

/** Resolves identifiers to their declarations inside one source file, following lexical scopes only. */
function scopeOf(sf) {
  const callSites = new Map();
  let indexed = false;

  const bindingNames = (name, found) => {
    if (ts.isIdentifier(name)) found.add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) bindingNames(element.name, found);
    return found;
  };
  const fromDeclaration = (declaration, name) => {
    if (ts.isIdentifier(declaration.name)) return declaration.name.text === name ? { kind: "variable", declaration, initializer: declaration.initializer } : null;
    return bindingNames(declaration.name, new Set()).has(name) ? { kind: "opaque" } : null;
  };
  const inStatements = (statements, name) => {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) { const hit = fromDeclaration(declaration, name); if (hit !== null) return hit; }
      } else if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return { kind: "function", node: statement };
      else if ((ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name?.text === name) return { kind: "opaque" };
      else if (ts.isImportDeclaration(statement) && statement.importClause !== undefined && ts.isStringLiteral(statement.moduleSpecifier)) {
        const clause = statement.importClause, module = statement.moduleSpecifier.text;
        if (clause.name?.text === name) return { kind: "import", module, imported: "default" };
        if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings) && clause.namedBindings.name.text === name) return { kind: "import", module, imported: "*" };
        if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings))
          for (const element of clause.namedBindings.elements) if (element.name.text === name) return { kind: "import", module, imported: (element.propertyName ?? element.name).text };
      } else if (ts.isImportEqualsDeclaration(statement) && statement.name.text === name) return { kind: "import", module: "", imported: "*" };
    }
    return null;
  };
  /** The declaration an identifier refers to, found by walking out through the enclosing scopes. */
  const lookup = identifier => {
    const name = identifier.text;
    for (let node = identifier.parent; node !== undefined; node = node.parent) {
      if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
        const hit = inStatements(node.statements, name);
        if (hit !== null) return hit;
      } else if (ts.isFunctionLike(node)) {
        if ((ts.isFunctionExpression(node)) && node.name?.text === name) return { kind: "function", node };
        for (const [index, parameter] of node.parameters.entries()) {
          if (ts.isIdentifier(parameter.name)) { if (parameter.name.text === name) return { kind: "parameter", fn: node, index, parameter }; }
          else if (bindingNames(parameter.name, new Set()).has(name)) return { kind: "opaque" };
        }
      } else if ((ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) && node.initializer !== undefined && ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) { const hit = fromDeclaration(declaration, name); if (hit !== null) return hit; }
      } else if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
        const hit = fromDeclaration(node.variableDeclaration, name);
        if (hit !== null) return hit;
      }
    }
    return null;
  };
  /** The function a binding stands for: a function declaration, or a variable initialised with an arrow or function expression. */
  const functionOf = binding => {
    if (binding === null) return null;
    if (binding.kind === "function") return binding.node;
    if (binding.kind === "variable" && binding.initializer !== undefined) {
      const value = unwrap(binding.initializer);
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value;
    }
    return null;
  };
  /** Calls in this file whose callee is an identifier that resolves to the given function. */
  const callsOf = fn => {
    if (!indexed) {
      indexed = true;
      const visit = node => {
        if (ts.isCallExpression(node)) {
          const callee = unwrap(node.expression);
          if (ts.isIdentifier(callee)) { const target = functionOf(lookup(callee)); if (target !== null) callSites.set(target, [...(callSites.get(target) ?? []), node]); }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return callSites.get(fn) ?? [];
  };
  return { lookup, functionOf, callsOf };
}

/** The expressions a function can return: the body of an expression-bodied arrow, otherwise every return statement of the function itself. */
function returnedExpressions(fn) {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return [fn.body];
  const found = [];
  const visit = node => {
    if (ts.isReturnStatement(node)) { if (node.expression !== undefined) found.push(node.expression); return; }
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    ts.forEachChild(node, visit);
  };
  if (fn.body !== undefined) ts.forEachChild(fn.body, visit);
  return found;
}

const lineOfNode = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

// ---------------------------------------------------------------------------------------------------------------------
// B8: options that must be given at a call
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Whether the expression is an object that certainly carries one of the named properties: an object literal with the
 * property (not set to undefined or null), a spread of such an object, both branches of a conditional, or a variable
 * initialised with one. Anything else, a parameter or a call result for example, cannot be shown and counts as "no".
 */
function carriesOption(scope, expression, names, depth = 0, seen = new Set()) {
  if (depth > MAX_DEPTH) return false;
  const value = unwrap(expression);
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.some(member => {
      if (ts.isSpreadAssignment(member)) return carriesOption(scope, member.expression, names, depth + 1, seen);
      const key = member.name !== undefined && (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) ? member.name.text : null;
      if (key === null || !names.includes(key)) return false;
      if (ts.isPropertyAssignment(member)) {
        const initializer = unwrap(member.initializer);
        return !(ts.isIdentifier(initializer) && initializer.text === "undefined") && initializer.kind !== ts.SyntaxKind.NullKeyword;
      }
      return true;
    });
  }
  if (ts.isConditionalExpression(value)) return carriesOption(scope, value.whenTrue, names, depth + 1, seen) && carriesOption(scope, value.whenFalse, names, depth + 1, seen);
  if (ts.isBinaryExpression(value) && (value.operatorToken.kind === ts.SyntaxKind.BarBarToken || value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
    return carriesOption(scope, value.left, names, depth + 1, seen) && carriesOption(scope, value.right, names, depth + 1, seen);
  if (ts.isIdentifier(value)) {
    const binding = scope.lookup(value);
    if (binding?.kind === "variable" && binding.initializer !== undefined && !seen.has(binding.declaration)) return carriesOption(scope, binding.initializer, names, depth + 1, new Set([...seen, binding.declaration]));
  }
  return false;
}

/** The exported name a call goes to when it is a call of an imported (or not otherwise declared) function, null for a local function of the same name. */
function calleeName(scope, call) {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) {
    const binding = scope.lookup(callee);
    if (binding === null || binding.kind === "opaque") return callee.text;
    return binding.kind === "import" && binding.imported !== "default" && binding.imported !== "*" ? binding.imported : null;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const binding = scope.lookup(callee.expression);
    if (binding?.kind === "import" && binding.imported === "*") return callee.name.text;
  }
  return null;
}

function checkCallOptions(rule, sf, scope, file, out) {
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(scope, node);
      const wanted = name === null ? undefined : rule.calls.find(call => call.callee === name);
      if (wanted !== undefined) {
        const argument = node.arguments[wanted.argument];
        const shown = argument !== undefined && !ts.isSpreadElement(argument) && carriesOption(scope, argument, wanted.anyOf);
        if (!shown) out.push(violation(file, lineOfNode(sf, node), rule.id, wanted.callee,
          `${wanted.callee}(...) does not visibly pass ${wanted.anyOf.join(" or ")} in argument ${wanted.argument + 1}${argument === undefined ? " (the argument is missing)" : ""} — ${rule.title}`));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ---------------------------------------------------------------------------------------------------------------------
// B9: flags that must be passed when a test starts an official command
// ---------------------------------------------------------------------------------------------------------------------

const emptyFlags = () => ({ must: new Set(), may: new Set(), open: false });
const openFlags = () => ({ must: new Set(), may: new Set(), open: true });
const union = sets => new Set(sets.flatMap(set => [...set]));
const both = parts => ({ must: union(parts.map(part => part.must)), may: union(parts.map(part => part.may)), open: parts.some(part => part.open) });
const either = parts => parts.length === 0 ? emptyFlags() : ({
  must: new Set([...parts[0].must].filter(flag => parts.every(part => part.must.has(flag)))), may: union(parts.map(part => part.may)), open: parts.some(part => part.open),
});
/** The flags written in a string: every blank-separated word that starts with a dash, without a `=value` tail. */
function flagsIn(text) {
  const found = new Set();
  for (const word of text.split(/\s+/u)) if (word.startsWith("-")) found.add(word.split("=", 1)[0]);
  return { must: found, may: new Set(found), open: false };
}
const stringsIn = node => {
  const found = [];
  const visit = child => { if (ts.isStringLiteralLike(child)) found.push(child.text); ts.forEachChild(child, visit); };
  visit(node);
  return found;
};

/**
 * The command-line flags an expression passes, as `{ must, may, open }`: flags certainly present, flags possibly present,
 * and whether part of the list could not be seen. It follows array literals and spreads, conditionals, variables, the
 * return values of helper functions in the same file, the arguments of those helpers (all their calls in the file), and the
 * array methods filter and concat. Whatever else it meets (a property, an imported helper) makes the result `open`.
 */
function flagsOf(scope, expression, depth = 0, seen = new Set()) {
  if (depth > MAX_DEPTH) return openFlags();
  const value = unwrap(expression);
  if (ts.isStringLiteralLike(value)) return flagsIn(value.text);
  if (ts.isTemplateExpression(value)) return both([flagsIn(value.head.text), ...value.templateSpans.map(span => flagsIn(span.literal.text))]);
  if (ts.isArrayLiteralExpression(value)) {
    return both(value.elements.map(element => {
      if (ts.isSpreadElement(element)) return flagsOf(scope, element.expression, depth + 1, seen);
      const single = flagsOf(scope, element, depth + 1, seen);
      return { ...single, open: false }; // one unknown element is a value, not a hidden list
    }));
  }
  if (ts.isConditionalExpression(value)) return either([flagsOf(scope, value.whenTrue, depth + 1, seen), flagsOf(scope, value.whenFalse, depth + 1, seen)]);
  if (ts.isBinaryExpression(value)) {
    const operator = value.operatorToken.kind;
    if (![ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.CommaToken, ts.SyntaxKind.PlusToken].includes(operator)) return emptyFlags();
    const left = flagsOf(scope, value.left, depth + 1, seen), right = flagsOf(scope, value.right, depth + 1, seen);
    switch (operator) {
      case ts.SyntaxKind.BarBarToken: case ts.SyntaxKind.QuestionQuestionToken: return either([left, right]);
      case ts.SyntaxKind.AmpersandAmpersandToken: return { must: new Set(), may: right.may, open: right.open };
      case ts.SyntaxKind.CommaToken: return right;
      case ts.SyntaxKind.PlusToken: return { ...both([left, right]), open: false }; // "--flag=" + value
      default: return emptyFlags();
    }
  }
  if (ts.isIdentifier(value)) {
    if (value.text === "undefined") return emptyFlags();
    const binding = scope.lookup(value);
    if (binding === null || binding.kind === "import" || binding.kind === "opaque") return openFlags();
    if (binding.kind === "variable") {
      if (binding.initializer === undefined || seen.has(binding.declaration)) return openFlags();
      return flagsOf(scope, binding.initializer, depth + 1, new Set([...seen, binding.declaration]));
    }
    if (binding.kind === "parameter") {
      if (binding.parameter.dotDotDotToken !== undefined || seen.has(binding.parameter)) return openFlags();
      const calls = scope.callsOf(binding.fn);
      if (calls.length === 0) return openFlags();
      const next = new Set([...seen, binding.parameter]);
      return either(calls.map(call => {
        if (call.arguments.some(argument => ts.isSpreadElement(argument))) return openFlags();
        const argument = call.arguments[binding.index];
        if (argument !== undefined) return flagsOf(scope, argument, depth + 1, next);
        return binding.parameter.initializer === undefined ? emptyFlags() : flagsOf(scope, binding.parameter.initializer, depth + 1, next);
      }));
    }
    return emptyFlags(); // a function value is not a list of flags
  }
  if (ts.isCallExpression(value)) {
    const callee = unwrap(value.expression);
    if (ts.isIdentifier(callee)) {
      const fn = scope.functionOf(scope.lookup(callee));
      if (fn === null || seen.has(fn)) return openFlags();
      const next = new Set([...seen, fn]), returned = returnedExpressions(fn);
      return returned.length === 0 ? emptyFlags() : either(returned.map(item => flagsOf(scope, item, depth + 1, next)));
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = flagsOf(scope, callee.expression, depth + 1, seen);
      switch (callee.name.text) {
        case "filter": { // a filter can only drop flags: those it names are no longer certain
          const dropped = new Set(value.arguments.flatMap(argument => stringsIn(argument)));
          return { must: new Set([...receiver.must].filter(flag => !dropped.has(flag))), may: receiver.may, open: receiver.open };
        }
        case "concat": return both([receiver, ...value.arguments.map(argument => flagsOf(scope, argument, depth + 1, seen))]);
        case "slice": case "toSorted": case "toReversed": return receiver;
        default: return openFlags();
      }
    }
    return openFlags();
  }
  if (ts.isObjectLiteralExpression(value) || ts.isNumericLiteral(value) || value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.NullKeyword) return emptyFlags();
  return openFlags();
}

/** The official command an expression refers to: a string ending in one of the entry paths, or a variable initialised with one. */
function entryIn(scope, node, entries, depth = 0, seen = new Set()) {
  let found = null;
  const visit = child => {
    if (found !== null) return;
    const texts = ts.isStringLiteralLike(child) ? [child.text] : ts.isTemplateExpression(child) ? [child.head.text, ...child.templateSpans.map(span => span.literal.text)] : [];
    for (const text of texts) { const hit = entries.find(entry => text === entry || text.endsWith("/" + entry)); if (hit !== undefined) { found = hit; return; } }
    if (ts.isPropertyAccessExpression(child)) { visit(child.expression); return; }
    if (ts.isPropertyAssignment(child)) { visit(child.initializer); return; }
    if (ts.isIdentifier(child) && depth < 3) {
      const binding = scope.lookup(child);
      if (binding?.kind === "variable" && binding.initializer !== undefined && !seen.has(binding.declaration)) found = entryIn(scope, binding.initializer, entries, depth + 1, new Set([...seen, binding.declaration]));
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/**
 * The child_process function a callee stands for: a property name (`cp.spawn`), an imported function under its own name
 * (`import { spawnSync as launch }`), a variable that is one of those (`const run = spawnSync`) or that wraps one in
 * promisify. Null for a local function that merely has such a name.
 */
function spawnerOf(scope, expression, depth = 0) {
  const callee = unwrap(expression);
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (!ts.isIdentifier(callee) || depth > 2) return null;
  const binding = scope.lookup(callee);
  if (binding === null || binding.kind === "opaque") return callee.text;
  if (binding.kind === "import") return binding.imported === "default" || binding.imported === "*" ? null : binding.imported;
  if (binding.kind === "variable" && binding.initializer !== undefined) {
    const value = unwrap(binding.initializer);
    if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value)) return spawnerOf(scope, value, depth + 1);
    if (ts.isCallExpression(value) && value.arguments.length === 1 && spawnerOf(scope, value.expression, depth + 1) === "promisify") return spawnerOf(scope, value.arguments[0], depth + 1);
  }
  return null;
}

function checkSpawnFlags(rule, sf, scope, file, out) {
  const visit = node => {
    const name = ts.isCallExpression(node) ? spawnerOf(scope, node.expression) : null;
    if (ts.isCallExpression(node) && name !== null && rule.spawners.has(name)) {
      const entry = node.arguments.map(argument => entryIn(scope, argument, rule.entries)).find(hit => hit !== null);
      if (entry !== undefined) {
        // exec and execSync take one command line; the others take the program and then its argument list.
        const list = name === "exec" || name === "execSync" ? node.arguments[0] : node.arguments[1];
        const flags = list === undefined ? emptyFlags() : flagsOf(scope, list);
        const line = lineOfNode(sf, node), hint = flags.open ? "; part of the argument list is not visible here, so write the flag out in the array or in a helper in the same file" : "";
        if (!rule.exemptFlags.some(flag => flags.must.has(flag))) {
          if (!flags.must.has(rule.requiredFlag))
            out.push(violation(file, line, rule.id, rule.requiredFlag, `starts ${entry} without ${rule.requiredFlag}${hint} — ${rule.title}`));
          for (const pair of rule.pairs) if (flags.may.has(pair.when) && !flags.must.has(pair.requires))
            out.push(violation(file, line, rule.id, pair.requires, `starts ${entry} with ${pair.when} but without ${pair.requires}${hint} — ${rule.title}`));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ---------------------------------------------------------------------------------------------------------------------
// One file
// ---------------------------------------------------------------------------------------------------------------------

function analyzeFile(root, file, rules, out) {
  const text = readFileSync(path.join(root, file), "utf8");
  const syntax = syntaxErrors(file, text);
  if (syntax.length > 0) {
    // The tree of a file that does not parse cannot be trusted, so no rule is applied to it.
    for (const error of syntax.slice(0, 3)) out.push(integrity(file, error.line, "syntax", `does not parse (${error.text}); no rule could be checked in this file`));
    return;
  }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const { edges, unclassified } = moduleReferences(sf);
  for (const item of unclassified) out.push(integrity(file, item.line, "specifier", `${item.form} with a specifier that is not a string literal cannot be checked against any rule`));
  const importing = [];
  for (const edge of edges) {
    const target = classify(edge.specifier, file);
    if (target.kind === "outside" || target.kind === "other") out.push(integrity(file, edge.line, "specifier", `${edge.form} "${edge.specifier}" ${target.kind === "outside" ? "leaves the repository" : "is not a relative path, a node: module or a package name"}, so it cannot be checked against any rule`));
    else importing.push(edge);
  }
  checkImportRules(rules.filter(rule => rule.kind === "imports" || rule.kind === "isolated"), file, importing, out);
  const calls = rules.filter(rule => (rule.kind === "call-options" || rule.kind === "spawn-flags") && anyMatch(rule.appliesTo, file));
  if (calls.length === 0) return;
  const scope = scopeOf(sf);
  for (const rule of calls) {
    if (rule.kind === "call-options") checkCallOptions(rule, sf, scope, file, out);
    else checkSpawnFlags(rule, sf, scope, file, out);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Exceptions and report
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Sets aside the violations that a registered exception covers (rule, file, key and, for imports, type-only-ness; at most
 * `count` of them). An exception that covers fewer than `count` violations is stale and fails the check, so the register
 * cannot outlive the code it excuses; violations beyond `count` stay violations.
 */
function applyExceptions(rules, violations, rulesLabel, problems) {
  const excepted = [];
  for (const rule of rules) for (const exception of rule.exceptions) {
    const covered = violations.filter(item => item.rule === rule.id && item.file === exception.file && item.key === exception.key && (exception.typeOnly === undefined || item.typeOnly === exception.typeOnly) && !item.excepted);
    for (const item of covered.slice(0, exception.count)) { item.excepted = exception; excepted.push(item); exception.used++; }
    if (exception.used < exception.count)
      problems.push(integrity(rulesLabel, 1, "exception", `registered exception of ${rule.id} for ${exception.file} (${exception.key}${exception.typeOnly === true ? ", import type" : ""}) expects ${exception.count} occurrence(s) but found ${exception.used}; remove or correct it`));
  }
  return excepted;
}

function main(argv) {
  let options;
  try { options = parseArgs({ args: argv, options: { root: { type: "string" }, rules: { type: "string" }, help: { type: "boolean", short: "h" } }, strict: true, allowPositionals: false }).values; }
  catch (error) { throw new UsageError(error instanceof Error ? error.message : String(error)); }
  if (options.help) { process.stdout.write("usage: node tools/check-boundaries.mjs [--root <dir>] [--rules <file>]\n"); return 0; }
  const root = path.resolve(options.root ?? SELF_ROOT);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new UsageError(`root ${root} is not a directory, so nothing was scanned`);
  const rulesFile = path.resolve(options.rules ?? path.join(SELF_ROOT, "tools", "boundary-rules.json"));
  const { scan, rules } = loadRules(rulesFile);
  const rulesLabel = path.relative(root, rulesFile).startsWith("..") ? rulesFile : path.relative(root, rulesFile);

  const violations = [];
  const { via, files, counts } = discover(root, scan, violations);
  for (const file of files) {
    try { analyzeFile(root, file, rules, violations); }
    catch (error) { violations.push(integrity(file, 1, "analysis", `the analysis failed (${error instanceof Error ? error.message : String(error)}); no rule could be checked in this file`)); }
  }
  const excepted = applyExceptions(rules, violations, rulesLabel, violations);
  const failures = violations.filter(item => item.excepted === undefined).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule, "en", { numeric: true }) || a.message.localeCompare(b.message));

  const byRoot = [...counts].map(([scanRoot, count]) => `${scanRoot} ${count}`).join(", ");
  const lines = [`check-boundaries: scanned ${files.length} files (${byRoot}) via ${via} against ${rules.length} rules from ${rulesLabel}`];
  for (const item of failures) lines.push(`${item.file}:${item.line} ${item.rule} ${item.message}`);
  for (const item of excepted.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) lines.push(`registered exception ${item.rule} ${item.file}:${item.line} ${item.key}${item.typeOnly === true ? " (import type)" : ""} — ${item.excepted.reason}`);
  const exceptions = `${excepted.length} registered exception${excepted.length === 1 ? "" : "s"}`;
  if (failures.length > 0) lines.push(`check-boundaries: FAILED — ${failures.length} violation${failures.length === 1 ? "" : "s"} in ${new Set(failures.map(item => item.file)).size} file${new Set(failures.map(item => item.file)).size === 1 ? "" : "s"}; ${exceptions} applied`);
  else lines.push(`check-boundaries: passed — no violations; ${exceptions}`);
  process.stdout.write(lines.join("\n") + "\n");
  return failures.length > 0 ? EXIT_VIOLATIONS : 0;
}

try { process.exitCode = main(process.argv.slice(2)); }
catch (error) {
  if (!(error instanceof UsageError)) throw error;
  process.stderr.write(`check-boundaries: ${error.message}\n`);
  process.exitCode = EXIT_USAGE;
}
