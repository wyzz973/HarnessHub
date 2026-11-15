// The packages a built tree of JavaScript imports by name (the Gateway and the desktop shell; the page's own are inside its bundle).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

const files = directory => readdirSync(directory).flatMap(name => { const path = join(directory, name); return statSync(path).isDirectory() ? files(path) : /\.c?js$/u.test(name) ? [path] : []; });
export function importedPackages(directories) {
  const named = new Set();
  for (const file of directories.flatMap(files))
    for (const match of readFileSync(file, "utf8").matchAll(/(?:^|[;\n])\s*(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']|(?:^|[;\n])\s*import\s*["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gu)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!/^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*(\/[^\s]*)?$/u.test(specifier)) continue;
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      if (!builtinModules.includes(name) && name !== "electron") named.add(name);
    }
  return named;
}
