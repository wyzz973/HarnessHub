// SPDX-License-Identifier: MIT
/**
 * Check module and package boundaries without executing project code.
 * Usage: node tools/check-boundaries.mjs [repository root]
 *
 * Scans the legacy tree `src/`, and `src/` and `test/` of every workspace
 * package under `packages/` and `apps/`, while OSS-004 moves code into
 * packages (docs/proposals/oss/13-package-migration.md):
 *
 * - Legacy modules (`allowed`) keep their rules, in src/ and inside packages.
 *   A package's src/ is either one flattened legacy module (FLAT_MODULES) or
 *   holds legacy modules as subdirectories; its other files are new package
 *   code, bound by the package graph and the third-party placement rules.
 *   Package and application tests are bound by the graph only.
 * - `@harnesshub/<package>` imports follow the dependency graph of
 *   docs/proposals/oss/02-architecture.md section 8 (PACKAGE_GRAPH, APP_GRAPH).
 * - src/ may import a package only through LEGACY_ALIASES, which names the
 *   legacy module whose rules apply to it, and only when the package that
 *   the importing file moves to (LEGACY_DESTINATIONS) may depend on it.
 * - Relative imports and `new URL(..., import.meta.url)` inside a package or
 *   application must stay inside it.
 * - Inside the daemon (and the src/ files that move to it), only worker/ may
 *   import @harnesshub/drivers.
 * - node:sqlite belongs in the storage module of @harnesshub/store. Inside
 *   packages, node:child_process is allowed only by CHILD_PROCESS_EXCEPTIONS,
 *   each of which expires when its TODO.md task is ticked.
 *
 * Exits non-zero for any violation and when no source file is found.
 */
import { readdirSync, readFileSync } from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const allowed = {
  domain: ["domain"],
  application: ["application", "runtime", "domain"],
  runtime: ["runtime", "domain"],
  gateway: ["gateway", "application", "domain"],
  engine: ["engine", "domain"],
  process: ["process", "domain"],
  worker: ["worker", "drivers", "domain", "logging"],
  drivers: ["drivers", "domain", "platform"],
  storage: ["storage", "domain"],
  artifacts: ["artifacts", "domain", "platform"],
  platform: ["platform", "domain"],
  distribution: ["distribution", "domain", "tool-packages"],
  "tool-packages": ["tool-packages", "domain", "platform"],
  rollout: ["rollout", "application", "domain"],
  logging: ["logging", "domain"],
  benchmark: ["benchmark", "application", "domain"],
};

/** Internal dependencies of each workspace package (02 section 8). */
export const PACKAGE_GRAPH = {
  core: [],
  store: ["core"],
  secrets: ["core"],
  gateway: ["core", "store", "secrets"],
  agents: ["core", "store", "secrets"],
  runtime: ["core", "store", "agents"],
  drivers: ["core"],
  "plugin-host": ["core"],
  daemon: [
    "core",
    "store",
    "secrets",
    "gateway",
    "agents",
    "runtime",
    "drivers",
    "plugin-host",
  ],
  cli: ["core", "sdk"],
  sdk: ["core"],
  console: ["sdk"],
};

/** Applications only dispatch to the packages that own the commands. */
export const APP_GRAPH = { hh: ["cli", "daemon"] };

/** Packages whose src/ is one flattened legacy module. */
export const FLAT_MODULES = {
  core: "domain",
  // drivers/src holds driver.ts, acp/, cli/ and fake/ of the drivers module.
  drivers: "drivers",
};

/**
 * Packages that src/ may import during the migration, and the legacy module
 * whose rules apply: a string for a flattened package, or the legacy modules a
 * package holds as subdirectories, of which the import's first subpath segment
 * must be one.
 */
export const LEGACY_ALIASES = {
  core: "domain",
  store: ["storage", "platform"],
  // secrets.ts came from drivers/configuration; src/ keeps the drivers rules for it.
  secrets: "drivers",
  // The model gateway came from drivers/chat-completions.
  gateway: "drivers",
  drivers: "drivers",
};

/**
 * The package each legacy path moves to (13-package-migration section 2),
 * most specific prefix first. A src/ file may import only the packages its
 * destination may depend on, so an edge that would break the 02 graph after
 * the move (such as agents' prepare.ts importing the gateway, V1) fails now.
 */
export const LEGACY_DESTINATIONS = [
  ["drivers/configuration/probe.ts", "runtime"],
  ["drivers/configuration/", "agents"],
  ["drivers/tool-command/", "agents"],
  ["drivers/", "drivers"],
  ["application/engine-configuration.ts", "agents"],
  ["application/harness-model.ts", "agents"],
  ["application/", "runtime"],
  ["engine/", "agents"],
  ["tool-packages/", "agents"],
  ["runtime/", "runtime"],
  ["process/", "runtime"],
  ["benchmark/", "runtime"],
  ["artifacts/", "runtime"],
  ["gateway/", "daemon"],
  ["logging/", "daemon"],
  ["worker/", "daemon"],
  ["main.ts", "daemon"],
  ["benchmark-main.ts", "daemon"],
  ["tool-packages-main.ts", "daemon"],
  ["cli.ts", "cli"],
  ["rollout/", "cli"],
];

/** The package a legacy path moves to, or undefined when the table names none. */
export function legacyDestination(legacyPath) {
  return LEGACY_DESTINATIONS.find(([prefix]) =>
    legacyPath.startsWith(prefix),
  )?.[1];
}

/**
 * Temporary node:child_process exceptions inside packages (ADR 0017, decision
 * 4): the package and source path each covers, its owner, and the TODO.md task
 * whose completion ends it. Once that task is ticked the import fails again.
 */
export const CHILD_PROCESS_EXCEPTIONS = [
  {
    package: "store",
    path: "platform/",
    owner: "OSS-010 F08",
    expiresWith: "OSS-013",
  },
  {
    package: "secrets",
    path: "secrets.ts",
    owner: "OSS-010 F08",
    expiresWith: "OSS-013",
  },
  {
    package: "drivers",
    path: "cli/",
    owner: "OSS-010 F08",
    expiresWith: "OSS-013",
  },
];

/** Inside the daemon, only the Worker loads drivers (02 section 8, 13 section 3). */
const DRIVER_LOADER = "worker/";

const domainPackages = new Set(["node:crypto", "node:buffer", "ajv"]);

function location(file, node) {
  return file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

const segments = (from, to) => relative(from, to).split(sep);

/** Whether path is strictly inside directory. */
function inside(directory, path) {
  const rest = relative(directory, path);
  return rest !== "" && !isAbsolute(rest) && rest.split(sep)[0] !== "..";
}

/**
 * Where a file lives: the legacy tree, a package or an application, the
 * directory its relative references must stay in, and its legacy module path
 * (null for package and application tests, which have no module rules).
 */
export function classify(path, root) {
  const [top, name, area, ...rest] = segments(root, path);
  if (top === "src")
    return {
      kind: "legacy",
      container: join(root, "src"),
      legacyPath: segments(join(root, "src"), path).join("/"),
    };
  if ((top === "packages" || top === "apps") && name && rest.length) {
    const graph = top === "packages" ? PACKAGE_GRAPH : APP_GRAPH;
    const flat = top === "packages" ? FLAT_MODULES[name] : undefined;
    return {
      kind: top === "packages" ? "package" : "app",
      name,
      known: Object.hasOwn(graph, name),
      container: join(root, top, name),
      sourcePath: area === "src" ? rest.join("/") : null,
      legacyPath:
        area === "src" ? [...(flat ? [flat] : []), ...rest].join("/") : null,
    };
  }
  return { kind: "outside", container: root, legacyPath: null };
}

/** Package code that belongs to no legacy module. */
const NEW_CODE = "(new package code)";

/**
 * Legacy module of a classified file: a top-level file of src/ is a
 * composition root; package files outside a legacy module are NEW_CODE;
 * tests have none (null).
 */
function moduleOf(where) {
  if (where.legacyPath === null) return null;
  const path = where.legacyPath.split("/");
  if (where.kind === "legacy") return path.length > 1 ? path[0] : "composition";
  return path.length > 1 && Object.hasOwn(allowed, path[0])
    ? path[0]
    : NEW_CODE;
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Inspect import syntax without executing project code. Includes re-exports,
 * type-only imports, import types, dynamic imports, CommonJS require calls and,
 * inside packages and applications, `new URL(..., import.meta.url)`.
 * Nonliteral imports fail because their dependency cannot be checked statically.
 *
 * @param {string} filePath Absolute path of the file.
 * @param {string} contents Its source text.
 * @param {string} root Repository root.
 * @param {{completedTasks?: Set<string> | null}} [options] TODO.md tasks marked
 *   done, which end CHILD_PROCESS_EXCEPTIONS; null when unknown, in which case
 *   using an exception fails.
 * @returns {string[]} One message per violation, prefixed with the file and line.
 */
export function checkSource(
  filePath,
  contents,
  root,
  { completedTasks = null } = {},
) {
  const file = ts.createSourceFile(
    filePath,
    contents,
    ts.ScriptTarget.Latest,
    true,
  );
  const where = classify(filePath, root);
  const owner = moduleOf(where);
  const display = relative(root, filePath).split(sep).join("/");
  const failures = [];
  const report = (node, message) => {
    failures.push(`${display}:${location(file, node)} ${message}`);
  };
  if (where.kind === "outside")
    return [`${display}:1 file is outside src/, packages/ and apps/`];
  if (where.kind !== "legacy" && !where.known)
    failures.push(
      `${display}:1 unknown ${where.kind} ${where.name}; add it to the dependency graph before use`,
    );
  if (
    owner !== null &&
    owner !== "composition" &&
    owner !== NEW_CODE &&
    !Object.hasOwn(allowed, owner)
  )
    failures.push(
      `${display}:1 unknown module ${owner}; define its boundary before use`,
    );
  const container =
    where.kind === "legacy"
      ? "src"
      : `${where.kind === "app" ? "apps" : "packages"}/${where.name}`;
  const moduleAllows = (target) =>
    owner === null ||
    owner === "composition" ||
    owner === NEW_CODE ||
    allowed[owner]?.includes(target);

  const inspectRelative = (node, specifier) => {
    const targetPath = resolve(dirname(filePath), specifier);
    if (!inside(where.container, targetPath)) {
      report(
        node,
        where.kind === "legacy"
          ? `${owner} cannot depend on outside-src: ${specifier}`
          : `relative import leaves ${container}: ${specifier}`,
      );
      return;
    }
    const target = moduleOf(classify(targetPath, root));
    if (target !== null && !moduleAllows(target))
      report(node, `${owner} cannot depend on ${target}: ${specifier}`);
  };

  const inspectWorkspace = (node, specifier) => {
    const [, name, ...subpath] = specifier.split("/");
    if (!Object.hasOwn(PACKAGE_GRAPH, name)) {
      report(node, `unknown workspace package: ${specifier}`);
      return;
    }
    if (where.kind === "legacy") {
      if (!Object.hasOwn(LEGACY_ALIASES, name)) {
        report(
          node,
          `src cannot import @harnesshub/${name} before it has a legacy alias: ${specifier}`,
        );
        return;
      }
      const alias = LEGACY_ALIASES[name];
      const target = typeof alias === "string" ? alias : subpath[0];
      if (Array.isArray(alias) && !alias.includes(target)) {
        report(
          node,
          `@harnesshub/${name} holds no legacy module ${target}: ${specifier}`,
        );
        return;
      }
      if (!moduleAllows(target)) {
        report(node, `${owner} cannot depend on ${target}: ${specifier}`);
        return;
      }
      const destination = legacyDestination(where.legacyPath);
      if (
        destination !== undefined &&
        destination !== name &&
        !PACKAGE_GRAPH[destination].includes(name)
      )
        report(
          node,
          `src/${where.legacyPath} moves to @harnesshub/${destination}, which cannot depend on @harnesshub/${name}: ${specifier}`,
        );
      else if (
        name === "drivers" &&
        destination === "daemon" &&
        !where.legacyPath.startsWith(DRIVER_LOADER)
      )
        report(
          node,
          `only src/${DRIVER_LOADER} may import @harnesshub/drivers among the files that move to the daemon: ${specifier}`,
        );
      return;
    }
    const graph = where.kind === "app" ? APP_GRAPH : PACKAGE_GRAPH;
    if (!graph[where.name]?.includes(name)) {
      report(node, `${container} cannot depend on @harnesshub/${name}`);
      return;
    }
    if (
      name === "drivers" &&
      where.kind === "package" &&
      where.name === "daemon" &&
      !where.sourcePath?.startsWith(DRIVER_LOADER)
    ) {
      report(
        node,
        `only ${DRIVER_LOADER} of packages/daemon may import @harnesshub/drivers: ${specifier}`,
      );
      return;
    }
    const target = FLAT_MODULES[name] ?? subpath[0];
    if (Object.hasOwn(allowed, target) && !moduleAllows(target))
      report(node, `${owner} cannot depend on ${target}: ${specifier}`);
  };

  const inspect = (node, argument) => {
    if (!argument || !ts.isStringLiteralLike(argument)) {
      report(node, "nonliteral import/require cannot be checked");
      return;
    }
    const specifier = argument.text;
    if (specifier.startsWith(".")) {
      inspectRelative(node, specifier);
      return;
    }
    if (specifier.startsWith("@harnesshub/")) {
      inspectWorkspace(node, specifier);
      return;
    }
    if (
      specifier.startsWith("/") ||
      specifier.startsWith("#") ||
      specifier.startsWith("file:") ||
      specifier.startsWith("harnesshub/")
    ) {
      report(node, `unmapped import cannot be checked: ${specifier}`);
      return;
    }
    if (owner === null) return;
    const dependency = packageName(specifier);
    const sdk =
      dependency === "acpx" || dependency === "@agentclientprotocol/sdk";
    const withinAcp =
      where.legacyPath.split("/").slice(0, 2).join("/") === "drivers/acp";
    if (sdk && !withinAcp)
      report(
        node,
        `ACP SDK types and implementation belong in drivers/acp: ${specifier}`,
      );
    if (
      (specifier === "node:sqlite" || specifier === "sqlite") &&
      (owner !== "storage" ||
        (where.kind !== "legacy" && where.name !== "store"))
    ) {
      report(
        node,
        `SQLite belongs in storage of @harnesshub/store: ${specifier}`,
      );
    }
    if (specifier === "node:child_process" || specifier === "child_process") {
      if (where.kind === "legacy") {
        if (!["process", "drivers", "platform", "composition"].includes(owner))
          report(
            node,
            `process creation belongs in ProcessHost or Driver: ${specifier}`,
          );
      } else inspectChildProcess(node, specifier);
    }
    if (owner === "domain" && !domainPackages.has(dependency)) {
      report(node, `domain cannot import concrete dependency: ${specifier}`);
    }
    if (
      ["runtime", "application"].includes(owner) &&
      !specifier.startsWith("node:")
    ) {
      report(
        node,
        `${owner} must use injected ports, not external implementations: ${specifier}`,
      );
    }
    if (
      owner === "gateway" &&
      !specifier.startsWith("node:") &&
      !["fastify", "@fastify/swagger", "ajv"].includes(dependency)
    ) {
      report(
        node,
        `gateway dependency is outside HTTP/schema responsibilities: ${specifier}`,
      );
    }
  };

  /** Inside packages only an unexpired CHILD_PROCESS_EXCEPTIONS entry allows node:child_process. */
  const inspectChildProcess = (node, specifier) => {
    const exception = CHILD_PROCESS_EXCEPTIONS.find(
      (entry) =>
        where.kind === "package" &&
        entry.package === where.name &&
        where.sourcePath?.startsWith(entry.path),
    );
    const scope = exception && `${exception.package}/${exception.path}`;
    if (!exception)
      report(
        node,
        `process creation belongs in ProcessHost or Driver; ${container} has no child_process exception: ${specifier}`,
      );
    else if (completedTasks === null)
      report(
        node,
        `the child_process exception for ${scope} ends with ${exception.expiresWith}; TODO.md is needed to check it: ${specifier}`,
      );
    else if (completedTasks.has(exception.expiresWith))
      report(
        node,
        `the child_process exception for ${scope} (owner ${exception.owner}) expired with ${exception.expiresWith}: ${specifier}`,
      );
  };

  /** `new URL(x, import.meta.url)` in a package or application must name its own file. */
  const inspectUrl = (node) => {
    const [first, base] = node.arguments ?? [];
    const fromModule =
      base &&
      ts.isPropertyAccessExpression(base) &&
      ts.isMetaProperty(base.expression) &&
      base.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      base.name.text === "url";
    if (!fromModule) return;
    if (!first || !ts.isStringLiteralLike(first)) {
      report(
        node,
        "nonliteral new URL(..., import.meta.url) cannot be checked",
      );
      return;
    }
    if (!inside(where.container, resolve(dirname(filePath), first.text)))
      report(node, `new URL leaves ${container}: ${first.text}`);
  };

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      inspect(node, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      inspect(node, node.moduleReference.expression);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      inspect(node, node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      inspect(node, node.arguments[0]);
    } else if (
      where.kind !== "legacy" &&
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL"
    ) {
      inspectUrl(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return failures;
}

function sourceFiles(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Symbolic links are not source modules: ${path}`);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".mts", ".cts", ".tsx"].includes(extname(path))
      ? [path]
      : [];
  });
}

/** The scanned trees: src/, and src/ and test/ of each package and application. */
function sourceTrees(root) {
  const trees = [join(root, "src")];
  for (const top of ["packages", "apps"]) {
    let entries;
    try {
      entries = readdirSync(join(root, top), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries)
      if (entry.isDirectory())
        trees.push(
          join(root, top, entry.name, "src"),
          join(root, top, entry.name, "test"),
        );
  }
  return trees;
}

/**
 * Tasks ticked in TODO.md (`- [x] **OSS-013 ...`), or null without TODO.md.
 *
 * @param {string} root Repository root.
 * @returns {Set<string> | null}
 */
export function completedTasks(root) {
  let text;
  try {
    text = readFileSync(join(root, "TODO.md"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return new Set(
    [...text.matchAll(/^\s*- \[x\] \*\*([A-Z]+-\d+)\b/gm)].map(
      (match) => match[1],
    ),
  );
}

/** Check a repository; a repository without source files and any violation are failures. */
export function checkBoundaries(root) {
  const files = sourceTrees(root).flatMap(sourceFiles);
  if (!files.length)
    throw new Error(
      "No source files found; module boundaries were not verified.",
    );
  const options = { completedTasks: completedTasks(root) };
  return {
    count: files.length,
    failures: files.flatMap((file) =>
      checkSource(file, readFileSync(file, "utf8"), root, options),
    ),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const root = resolve(
      process.argv[2] ?? fileURLToPath(new URL("../", import.meta.url)),
    );
    const result = checkBoundaries(root);
    if (result.failures.length) {
      console.error(result.failures.join("\n"));
      process.exitCode = 1;
    } else {
      console.log(
        `Module boundaries verified for ${result.count} source files.`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
