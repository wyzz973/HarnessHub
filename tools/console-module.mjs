// SPDX-License-Identifier: MIT
/**
 * Loads a console module (packages/console) in Node for the tooling tests:
 * TypeScript is transpiled, relative and `@/` imports are loaded the same
 * way, `@harnesshub/sdk/*` resolves to the SDK's build and other packages
 * to the console's dependencies. Modules with the same source are the same
 * module, so state such as the console's locale is shared between them.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const CONSOLE = fileURLToPath(new URL("../packages/console/", import.meta.url));
const SDK = fileURLToPath(new URL("../packages/sdk/dist/src/", import.meta.url));
const requireFromConsole = createRequire(path.join(CONSOLE, "package.json"));

async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

async function resolve(specifier, from) {
  if (specifier.startsWith("@harnesshub/sdk/"))
    return pathToFileURL(
      path.join(SDK, `${specifier.slice("@harnesshub/sdk/".length)}.js`),
    ).href;
  const local = specifier.startsWith("@/")
    ? path.join(CONSOLE, specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(from), specifier)
      : undefined;
  if (local === undefined)
    return pathToFileURL(requireFromConsole.resolve(specifier)).href;
  for (const candidate of [
    `${local}.ts`,
    `${local}.tsx`,
    path.join(local, "index.ts"),
    local,
  ])
    if (await exists(candidate)) return candidate;
  throw new Error(`${from} imports ${specifier}, which does not exist`);
}

async function load(file, replacements, seen) {
  if (seen.has(file)) return seen.get(file);
  let source = await readFile(file, "utf8");
  for (const [from, to] of Object.entries(replacements))
    source = source.replaceAll(from, to);
  // Only import and export statements: a quoted word elsewhere (such as a
  // message key ending in "import") is not a module.
  const specifiers = new Set(
    [
      ...source.matchAll(
        /^\s*(?:import|export)\b[^"]*?\bfrom\s*"([^"]+)"|^\s*import\s*"([^"]+)"/gm,
      ),
    ].map((match) => match[1] ?? match[2]),
  );
  for (const specifier of specifiers) {
    if (specifier.startsWith("data:") || specifier.startsWith("file:")) continue;
    const target = await resolve(specifier, file);
    const url = target.startsWith("file:")
      ? target
      : await load(target, replacements, seen);
    source = source.replaceAll(`"${specifier}"`, JSON.stringify(url));
  }
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2024,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: file,
  }).outputText;
  const url = `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
  seen.set(file, url);
  return url;
}

/**
 * Import `file` (relative to packages/console). `replacements` rewrite the
 * source of every module loaded, e.g. to stand in for one that needs a
 * browser session.
 */
export async function consoleModule(file, replacements = {}) {
  return import(await load(path.join(CONSOLE, file), replacements, new Map()));
}
