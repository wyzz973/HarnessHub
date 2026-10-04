// SPDX-License-Identifier: MIT
/**
 * Check package and module boundaries without executing project code
 * (OSS-005; 10-engineering section 1). Usage:
 * node tools/check-boundaries.mjs [repository root]
 *
 * Manifests. The internal @harnesshub/* dependencies that each package.json
 * under packages/ and apps/ declares, in any dependency field, are a subset
 * of its entry in the dependency graph of 02-architecture section 8
 * (PACKAGE_GRAPH, APP_GRAPH), and its name matches its directory.
 *
 * Sources. Every import (static, dynamic, type-only, import types,
 * re-exports and require) of a scanned file is checked:
 * - It may only target a dependency that its package declares. src/, the
 *   console's source directories, agents' assets/ and applications' bin/
 *   may use dependencies, peerDependencies and optionalDependencies; test/
 *   also devDependencies. Internal and third-party packages alike, so workspace
 *   hoisting cannot mask a missing declaration; Node built-ins need none.
 *   Root tests/ may use what the root package.json declares, whose
 *   devDependencies are the tests' dependencies.
 * - Black-box trees (BLACK_BOX: conformance/, tests/e2e/, tests/browser/ and
 *   examples/, where present) may use only @harnesshub/core, @harnesshub/sdk,
 *   Node built-ins (HTTP, and starting the `hh` command) and their own files.
 * - Inside packages and applications, @harnesshub/* imports also follow the
 *   graph, and legacy module rules (`allowed`) keep applying to package
 *   files through PACKAGE_ORIGINS; package files outside any legacy module
 *   are package-level code, which the package's modules may use. Relative
 *   imports and `new URL(..., import.meta.url)` stay inside their package,
 *   application or black-box tree (a package URL resolves from its compiled
 *   file, `dist/src/...`). In the daemon only worker/ imports
 *   @harnesshub/drivers. node:sqlite belongs in the storage module of
 *   @harnesshub/store and node:child_process in runtime's process/
 *   (PROCESS_LAUNCHERS); everything else takes an injected ProcessLauncher.
 *
 * agents' assets/ and applications' bin/ ship inside their packages as
 * programs run by path: they get the declared-dependency rule and stay
 * inside their package, but not the module-placement rules, because the
 * assets launchers start the engine they wrap themselves and are documented
 * as outside the ProcessLauncher (ADR 0017, F08 addendum, 范围). A computed
 * dynamic import there fails, except in COMPUTED_IMPORTS.
 *
 * Not yet enforced: that a package's public types do not expose third-party
 * types, which the API Extractor reports will check (10-engineering section 2).
 *
 * Exits non-zero for any violation and when no source file is found.
 */
import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
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
  // The Worker entry composes its process: it creates the process launcher.
  worker: ["worker", "drivers", "domain", "logging", "process"],
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
  // The daemon serves the console's build (ADR-P10); it imports only its
  // location, `@harnesshub/console/assets`.
  daemon: [
    "core",
    "store",
    "secrets",
    "gateway",
    "agents",
    "runtime",
    "drivers",
    "plugin-host",
    "console",
  ],
  cli: ["core", "sdk"],
  sdk: ["core"],
  console: ["sdk"],
};

/**
 * Source directories of packages that do not use src/ and test/: the Vite
 * console keeps its code in src/, components/ and lib/. Their files are bound
 * by the dependency graph (console may import only the sdk) and the
 * stay-inside rule, without legacy module rules.
 */
export const SOURCE_AREAS = { console: ["src", "components", "lib"] };

/** Applications only dispatch to the packages that own the commands. */
export const APP_GRAPH = { hh: ["cli", "daemon"] };

/** npm names of the applications; packages are named `@harnesshub/<directory>`. */
export const APP_NAMES = { hh: "harnesshub" };

/**
 * Black-box trees (10-engineering section 1): they exercise HarnessHub only
 * through @harnesshub/core, @harnesshub/sdk, the HTTP interface and the `hh`
 * command, so they may import only these packages, Node built-ins and their
 * own files. Trees that do not exist are skipped.
 */
export const BLACK_BOX = [
  "conformance",
  "tests/e2e",
  "tests/browser",
  "examples",
];
const BLACK_BOX_PACKAGES = new Set(["core", "sdk"]);

/**
 * Import aliases of a package's tsconfig `paths`: the console's `@/x` is the
 * package's own `x` (packages/console/tsconfig.json).
 */
export const PATH_ALIASES = { console: { "@/": "" } };

/**
 * Program areas: shipped inside their package and run by path, with the
 * declared-dependency and stay-inside rules but no module rules (see above).
 */
const PROGRAM_AREAS = { packages: ["assets"], apps: ["bin"] };

/**
 * The only files allowed a computed dynamic import, each with its reason:
 * the Pi extension imports the MCP SDK from the engine's own installation,
 * whose location it receives at run time.
 */
export const COMPUTED_IMPORTS = {
  "packages/agents/assets/native-mcp/pi-extension.mjs":
    "loads the MCP SDK from the engine's own installation",
};

/** Dependency fields whose packages a file may import, by package area. */
const RUNTIME_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
];
const TEST_FIELDS = [...RUNTIME_FIELDS, "devDependencies"];

/**
 * The packages a manifest lets a file in the given area import.
 *
 * @param {Record<string, unknown>} manifest Parsed package.json.
 * @param {string} area First directory below the package (src, test, ...).
 * @returns {Set<string>}
 */
export function declaredDependencies(manifest, area) {
  const names = new Set();
  for (const field of area === "test" ? TEST_FIELDS : RUNTIME_FIELDS) {
    const entries = manifest[field];
    if (entries && typeof entries === "object")
      for (const name of Object.keys(entries)) names.add(name);
  }
  return names;
}

/**
 * Violations of a package or application manifest: its name must match its
 * directory, and every internal dependency it declares, in any field, must be
 * in its dependency graph entry.
 *
 * @param {"package" | "app"} kind
 * @param {string} directory The package's directory name.
 * @param {Record<string, unknown>} manifest Parsed package.json.
 * @returns {string[]}
 */
export function checkManifest(kind, directory, manifest) {
  const top = kind === "app" ? "apps" : "packages";
  const display = `${top}/${directory}/package.json`;
  const graph = kind === "app" ? APP_GRAPH : PACKAGE_GRAPH;
  if (!Object.hasOwn(graph, directory))
    return [
      `${display} unknown ${kind} ${directory}; add it to the dependency graph before use`,
    ];
  const failures = [];
  const name =
    kind === "app" ? APP_NAMES[directory] : `@harnesshub/${directory}`;
  if (manifest.name !== name)
    failures.push(
      `${display} is named ${JSON.stringify(manifest.name)}, not ${name}`,
    );
  for (const field of TEST_FIELDS) {
    const entries = manifest[field];
    if (!entries || typeof entries !== "object") continue;
    for (const dependency of Object.keys(entries)) {
      const internal = dependency.startsWith("@harnesshub/")
        ? dependency.slice("@harnesshub/".length)
        : Object.values(APP_NAMES).includes(dependency)
          ? dependency
          : undefined;
      if (internal !== undefined && !graph[directory].includes(internal))
        failures.push(
          `${display} declares ${dependency} in ${field}, outside its dependency graph`,
        );
    }
  }
  return failures;
}

/**
 * Where the src/ of each package that came from the legacy tree came from: a
 * string when its whole src/ was one legacy directory, or the legacy origin of
 * each renamed first-level subdirectory or single file, written without its
 * extension (the others kept their names, such as store's storage/ and
 * platform/). Their files keep the rules of those legacy modules. Packages
 * without an entry hold only new code.
 */
export const PACKAGE_ORIGINS = {
  core: "domain",
  store: {},
  secrets: "drivers/configuration",
  gateway: "drivers/chat-completions",
  drivers: "drivers",
  agents: {
    configuration: "drivers/configuration",
    "tool-command": "drivers/tool-command",
  },
  // The configuration probe moved into process/ but keeps its drivers rules.
  runtime: { "process/probe": "drivers/configuration/probe" },
  // The daemon's HTTP layer is the former gateway module.
  daemon: { http: "gateway" },
  cli: {},
};

/**
 * The legacy path of a file in a package's src/, or undefined for a package
 * without legacy origin.
 *
 * @param {string} name Package directory name.
 * @param {string} sourcePath Slash-separated path below the package's src/.
 */
export function legacyPathOf(name, sourcePath) {
  const origin = PACKAGE_ORIGINS[name];
  if (origin === undefined) return undefined;
  if (typeof origin === "string") return `${origin}/${sourcePath}`;
  const file = sourcePath.replace(/\.(?:[cm]?ts|tsx)$/, "");
  if (Object.hasOwn(origin, file))
    return `${origin[file]}${sourcePath.slice(file.length)}`;
  const [first, ...rest] = sourcePath.split("/");
  return [origin[first] ?? first, ...rest].join("/");
}

/**
 * Where node:child_process belongs: runtime's process/, the home of the
 * ProcessLauncher implementation and of the Worker supervision it builds on
 * (02 section 8, 10 section 2). There are no exceptions elsewhere.
 */
export const PROCESS_LAUNCHERS = [{ package: "runtime", path: "process/" }];

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
 * Where a file lives: a package or application (with its area, the first
 * directory below it), the root tests/, a black-box tree, or outside the
 * scanned trees; the directory its relative references must stay in; and,
 * for package and application src/ files, the legacy module path that
 * decides their module rules (null elsewhere).
 */
export function classify(path, root) {
  const parts = segments(root, path);
  const box = BLACK_BOX.find(
    (tree) => parts.slice(0, tree.split("/").length).join("/") === tree,
  );
  if (box !== undefined)
    return {
      kind: "black-box",
      container: join(root, ...box.split("/")),
      legacyPath: null,
    };
  const [top, name, area, ...rest] = parts;
  if (top === "tests")
    return { kind: "tests", container: join(root, "tests"), legacyPath: null };
  if ((top === "packages" || top === "apps") && name && rest.length) {
    const graph = top === "packages" ? PACKAGE_GRAPH : APP_GRAPH;
    const source = rest.join("/");
    return {
      kind: top === "packages" ? "package" : "app",
      name,
      area,
      program: PROGRAM_AREAS[top].includes(area),
      known: Object.hasOwn(graph, name),
      container: join(root, top, name),
      sourcePath: area === "src" ? source : null,
      legacyPath:
        area !== "src"
          ? null
          : ((top === "packages" ? legacyPathOf(name, source) : undefined) ??
            source),
    };
  }
  return { kind: "outside", container: root, legacyPath: null };
}

/** Package code that belongs to no legacy module. */
const NEW_CODE = "(new package code)";

/**
 * Legacy module of a classified file: package files outside a legacy module
 * are NEW_CODE; files without module rules (tests, assets) have none (null).
 */
function moduleOf(where) {
  if (where.legacyPath === null) return null;
  const path = where.legacyPath.split("/");
  return path.length > 1 && Object.hasOwn(allowed, path[0])
    ? path[0]
    : NEW_CODE;
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Where a scanned file's relative references must stay, for messages. */
function containerName(where, root) {
  return relative(root, where.container).split(sep).join("/");
}

/**
 * Inspect import syntax without executing project code. Includes re-exports,
 * type-only imports, import types, dynamic imports, CommonJS require calls and,
 * inside packages, applications and black-box trees,
 * `new URL(..., import.meta.url)`. Nonliteral imports fail because their
 * dependency cannot be checked statically.
 *
 * @param {string} filePath Absolute path of the file.
 * @param {string} contents Its source text.
 * @param {string} root Repository root.
 * @param {Set<string>} [declared] The packages the file's manifest lets it
 *   import (declaredDependencies). checkBoundaries always passes it; without
 *   it the declared-dependency rule is not applied, which only unit tests of
 *   the other rules rely on.
 * @returns {string[]} One message per violation, prefixed with the file and line.
 */
export function checkSource(filePath, contents, root, declared) {
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
    return [
      `${display}:1 file is outside packages/, apps/, tests/ and the black-box trees`,
    ];
  const packaged = where.kind === "package" || where.kind === "app";
  if (packaged && !where.known)
    failures.push(
      `${display}:1 unknown ${where.kind} ${where.name}; add it to the dependency graph before use`,
    );
  const container = containerName(where, root);
  const moduleAllows = (target) =>
    owner === null || owner === NEW_CODE || allowed[owner]?.includes(target);
  const blackBox = () =>
    `black-box code may use only @harnesshub/core, @harnesshub/sdk, HTTP and the hh command`;

  /** The declared-dependency rule: the manifest must list the package. */
  const inspectDeclared = (node, dependency) => {
    if (declared === undefined || declared.has(dependency)) return;
    report(
      node,
      `${container} imports ${dependency} without declaring it in package.json${
        where.kind === "tests"
          ? ""
          : where.area === "test"
            ? " (dependencies or devDependencies)"
            : " (dependencies, peerDependencies or optionalDependencies)"
      }`,
    );
  };

  const inspectRelative = (node, specifier, targetPath) => {
    if (!inside(where.container, targetPath)) {
      report(node, `relative import leaves ${container}: ${specifier}`);
      return;
    }
    const target = moduleOf(classify(targetPath, root));
    // Package-level code is shared by the package's own modules.
    if (target !== null && target !== NEW_CODE && !moduleAllows(target))
      report(node, `${owner} cannot depend on ${target}: ${specifier}`);
  };

  const inspectWorkspace = (node, specifier) => {
    const [, name, ...subpath] = specifier.split("/");
    if (!Object.hasOwn(PACKAGE_GRAPH, name)) {
      report(node, `unknown workspace package: ${specifier}`);
      return;
    }
    if (where.kind === "black-box") {
      if (!BLACK_BOX_PACKAGES.has(name))
        report(node, `${blackBox()}: ${specifier}`);
      return;
    }
    if (packaged) {
      const graph = where.kind === "app" ? APP_GRAPH : PACKAGE_GRAPH;
      if (!graph[where.name]?.includes(name)) {
        report(node, `${container} cannot depend on @harnesshub/${name}`);
        return;
      }
    }
    inspectDeclared(node, `@harnesshub/${name}`);
    if (
      name === "drivers" &&
      where.kind === "package" &&
      where.name === "daemon" &&
      // Tests are bound by the graph only, as everywhere else.
      where.sourcePath !== null &&
      !where.sourcePath.startsWith(DRIVER_LOADER)
    ) {
      report(
        node,
        `only ${DRIVER_LOADER} of packages/daemon may import @harnesshub/drivers: ${specifier}`,
      );
      return;
    }
    const target = legacyPathOf(name, subpath.join("/"))?.split("/")[0];
    if (
      target !== undefined &&
      Object.hasOwn(allowed, target) &&
      !moduleAllows(target)
    )
      report(node, `${owner} cannot depend on ${target}: ${specifier}`);
  };

  /** A tsconfig `paths` alias of the file's package, as a path, or undefined. */
  const aliasTarget = (specifier) => {
    if (where.kind !== "package") return undefined;
    for (const [prefix, target] of Object.entries(
      PATH_ALIASES[where.name] ?? {},
    ))
      if (specifier.startsWith(prefix))
        return resolve(where.container, target, specifier.slice(prefix.length));
    return undefined;
  };

  const inspect = (node, argument) => {
    if (!argument || !ts.isStringLiteralLike(argument)) {
      // Tests may load a fixture or a copied module from a computed path,
      // and COMPUTED_IMPORTS name the program files that must.
      const computed =
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        Object.hasOwn(COMPUTED_IMPORTS, display);
      if (where.kind !== "tests" && !computed)
        report(node, "nonliteral import/require cannot be checked");
      return;
    }
    const specifier = argument.text;
    if (specifier.startsWith(".")) {
      inspectRelative(node, specifier, resolve(dirname(filePath), specifier));
      return;
    }
    const aliased = aliasTarget(specifier);
    if (aliased !== undefined) {
      inspectRelative(node, specifier, aliased);
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
    const builtin = specifier.startsWith("node:") || isBuiltin(specifier);
    if (!builtin) {
      if (where.kind === "black-box") {
        report(node, `${blackBox()}: ${specifier}`);
        return;
      }
      inspectDeclared(node, packageName(specifier));
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
      (owner !== "storage" || where.name !== "store")
    ) {
      report(
        node,
        `SQLite belongs in storage of @harnesshub/store: ${specifier}`,
      );
    }
    if (specifier === "node:child_process" || specifier === "child_process")
      inspectChildProcess(node, specifier);
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

  /** Inside packages node:child_process belongs only in PROCESS_LAUNCHERS. */
  const inspectChildProcess = (node, specifier) => {
    const home = PROCESS_LAUNCHERS.some(
      (entry) =>
        where.kind === "package" &&
        entry.package === where.name &&
        where.sourcePath?.startsWith(entry.path),
    );
    if (!home)
      report(
        node,
        `process creation belongs in runtime's process/; ${container} takes an injected ProcessLauncher: ${specifier}`,
      );
  };

  /** `new URL(x, import.meta.url)` must name a file of its own tree. */
  const inspectUrl = (node) => {
    const [first, base] = node.arguments ?? [];
    const fromModule =
      base &&
      ts.isPropertyAccessExpression(base) &&
      ts.isMetaProperty(base.expression) &&
      base.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      base.name.text === "url";
    if (!fromModule) return;
    const literal = first !== undefined && ts.isStringLiteralLike(first);
    // In packages and applications, import.meta.url names the compiled file,
    // one level below dist/; program areas and black-box files run as written.
    const located =
      packaged && !where.program
        ? join(where.container, "dist", relative(where.container, filePath))
        : filePath;
    if (
      literal &&
      inside(where.container, resolve(dirname(located), first.text))
    )
      return;
    if (!literal)
      report(
        node,
        "nonliteral new URL(..., import.meta.url) cannot be checked",
      );
    else report(node, `new URL leaves ${container}: ${first.text}`);
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
      (packaged || where.kind === "black-box") &&
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

/** Source files: TypeScript, and JavaScript where trees hold it (assets, examples, fixtures). */
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"]);

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
    if (entry.isDirectory())
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(path);
    return SOURCE_EXTENSIONS.has(extname(path)) ? [path] : [];
  });
}

function directories(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`${path}: ${error.message}`);
  }
}

/**
 * The scanned trees: src/ and test/ (SOURCE_AREAS for the console) and the
 * program areas of each package and application, the root tests/
 * (black-box subtrees included) and the black-box trees.
 */
function sourceTrees(root) {
  const trees = [];
  for (const top of ["packages", "apps"])
    for (const name of directories(join(root, top)))
      for (const area of [
        ...(SOURCE_AREAS[name] ?? ["src", "test"]),
        ...PROGRAM_AREAS[top],
      ])
        trees.push(join(root, top, name, area));
  trees.push(join(root, "tests"));
  for (const tree of BLACK_BOX)
    if (!tree.startsWith("tests/")) trees.push(join(root, ...tree.split("/")));
  return trees;
}

/**
 * Check a repository: its manifests, then every scanned file against the
 * dependencies its manifest declares. A repository without source files, a
 * package or application without package.json, and any violation are
 * failures.
 */
export function checkBoundaries(root) {
  const failures = [];
  const manifests = new Map();
  for (const [top, kind] of [
    ["packages", "package"],
    ["apps", "app"],
  ])
    for (const name of directories(join(root, top))) {
      const path = join(root, top, name, "package.json");
      const manifest = readManifest(path);
      if (manifest === undefined) {
        failures.push(`${top}/${name}/package.json is missing`);
        continue;
      }
      manifests.set(join(root, top, name), manifest);
      failures.push(...checkManifest(kind, name, manifest));
    }
  const files = sourceTrees(root).flatMap(sourceFiles);
  if (!files.length)
    throw new Error(
      "No source files found; module boundaries were not verified.",
    );
  const rootManifest = readManifest(join(root, "package.json"));
  for (const file of files) {
    const where = classify(file, root);
    let declared;
    if (where.kind === "package" || where.kind === "app") {
      const manifest = manifests.get(where.container);
      // A missing manifest is reported once above.
      if (manifest !== undefined)
        declared = declaredDependencies(manifest, where.area);
    } else if (where.kind === "tests") {
      if (rootManifest === undefined) {
        failures.push("package.json is missing at the repository root");
        declared = new Set();
      } else declared = declaredDependencies(rootManifest, "test");
    }
    failures.push(
      ...checkSource(file, readFileSync(file, "utf8"), root, declared),
    );
  }
  return { count: files.length, failures: [...new Set(failures)] };
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
