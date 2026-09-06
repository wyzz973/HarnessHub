import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const allowed = {
  domain: ["domain"],
  application: ["application", "runtime", "domain"],
  runtime: ["runtime", "domain"],
  gateway: ["gateway", "application", "domain"],
  engine: ["engine", "domain"],
  process: ["process", "domain"],
  worker: ["worker", "drivers", "domain"],
  drivers: ["drivers", "domain", "platform"],
  storage: ["storage", "domain"],
  artifacts: ["artifacts", "domain", "platform"],
  platform: ["platform", "domain"],
  distribution: ["distribution", "domain", "tool-packages"],
  "tool-packages": ["tool-packages", "domain", "platform"],
  rollout: ["rollout", "application", "domain"],
  benchmark: ["benchmark", "application", "domain"],
};

const domainPackages = new Set(["node:crypto", "node:buffer", "ajv"]);

function location(file, node) {
  return file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function localModule(path, sourceRoot) {
  const parts = relative(sourceRoot, path).split(sep);
  if (parts[0] === ".." || parts[0] === "") return "outside-src";
  return parts.length === 1 ? "composition" : parts[0];
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Inspect import syntax without executing project code. Includes re-exports,
 * type-only imports, import types, dynamic imports and CommonJS require calls.
 * Nonliteral imports fail because their dependency cannot be checked statically.
 */
export function checkSource(filePath, contents, sourceRoot) {
  const file = ts.createSourceFile(
    filePath,
    contents,
    ts.ScriptTarget.Latest,
    true,
  );
  const owner = localModule(filePath, sourceRoot);
  const failures = [];
  const report = (node, message) => {
    failures.push(
      `${relative(sourceRoot, filePath)}:${location(file, node)} ${message}`,
    );
  };
  if (owner !== "composition" && !Object.hasOwn(allowed, owner)) {
    failures.push(
      `${relative(sourceRoot, filePath)}:1 unknown module ${owner}; define its boundary before use`,
    );
  }

  const inspect = (node, argument) => {
    if (!argument || !ts.isStringLiteralLike(argument)) {
      report(node, "nonliteral import/require cannot be checked");
      return;
    }
    const specifier = argument.text;
    if (specifier.startsWith(".")) {
      const target = localModule(
        resolve(dirname(filePath), specifier),
        sourceRoot,
      );
      if (
        target === "outside-src" ||
        (owner !== "composition" && !allowed[owner]?.includes(target))
      ) {
        report(node, `${owner} cannot depend on ${target}: ${specifier}`);
      }
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
    const dependency = packageName(specifier);
    const sdk =
      dependency === "acpx" || dependency === "@agentclientprotocol/sdk";
    const withinAcp =
      relative(sourceRoot, filePath).split(sep).slice(0, 2).join("/") ===
      "drivers/acp";
    if (sdk && !withinAcp)
      report(
        node,
        `ACP SDK types and implementation belong in drivers/acp: ${specifier}`,
      );
    if (
      (specifier === "node:sqlite" || specifier === "sqlite") &&
      owner !== "storage"
    ) {
      report(node, `SQLite belongs in storage: ${specifier}`);
    }
    if (
      (specifier === "node:child_process" || specifier === "child_process") &&
      !["process", "drivers", "platform", "composition"].includes(owner)
    ) {
      report(
        node,
        `process creation belongs in ProcessHost or Driver: ${specifier}`,
      );
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
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return failures;
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Symbolic links are not source modules: ${path}`);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".mts", ".cts", ".tsx"].includes(extname(path))
      ? [path]
      : [];
  });
}

/** Check a source tree; empty/missing trees and violations are failures. */
export function checkBoundaries(sourceRoot) {
  const files = sourceFiles(sourceRoot);
  if (!files.length)
    throw new Error(
      "No source files found; module boundaries were not verified.",
    );
  return {
    count: files.length,
    failures: files.flatMap((file) =>
      checkSource(file, readFileSync(file, "utf8"), sourceRoot),
    ),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const sourceRoot = resolve(
      process.argv[2] ?? fileURLToPath(new URL("../src", import.meta.url)),
    );
    const result = checkBoundaries(sourceRoot);
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
