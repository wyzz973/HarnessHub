#!/usr/bin/env node
/**
 * Static check of the native (PE) files in a portable Windows layout: which DLLs they
 * import and whether a brand-new Windows installation can resolve them without any
 * installed runtime. It executes nothing and needs no dependency, so it also runs on the
 * build machine against an extracted bundle.
 *
 * Every import of every .exe/.dll/.node/.pyd under --root is resolved the way the Windows
 * loader would find it, in this order: API set contract -> same directory as the importer
 * (application-local) -> the system directory given by --system32 (a real directory) or
 * --system-list (a file with one DLL name per line, e.g. `dir /b` of a clean machine) ->
 * a directory above the importer inside the layout (the directory of the hosting
 * executable, for example python.exe next to DLLs\*.pyd) -> the layout's Node runtime
 * directory for .node addons -> anywhere else in the layout (NOT guaranteed loadable) ->
 * missing.
 *
 * The result lists every redistributable Microsoft C/C++ runtime DLL (vcruntime140.dll,
 * msvcp140.dll, ...; not part of Windows) with how each importer resolves it, and every
 * import that is missing. `--reference-list` (DLL names of a full Windows installation)
 * separates "Windows component that the clean system lacks" from "found nowhere".
 *
 * Exit code: 0 no redistributable runtime import is missing or only reachable by luck;
 * 1 otherwise (only with --strict; without it the report is informational); 2 usage error.
 *
 * Usage: node scripts/check-bundle-native-deps.mjs --root DIR
 *   (--system32 DIR | --system-list FILE) [--reference-list FILE] [--out FILE]
 *   [--summary FILE] [--strict] [--ignore state,logs]
 */
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  isApiSet,
  isRedistributableRuntime,
  PeFormatError,
  readPeImports,
} from "./lib/pe-imports.mjs";

const peExtensions = new Set([".exe", ".dll", ".node", ".pyd"]);

async function* walk(root, ignored, relative = "") {
  const entries = await readdir(path.join(root, relative), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!relative && ignored.has(entry.name.toLowerCase())) continue;
      yield* walk(root, ignored, child);
    } else if (entry.isFile()) yield child;
  }
}

async function nameList(file) {
  const raw = await readFile(file, "utf8");
  // PowerShell 5.1 redirection writes a byte order mark.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function directoryNames(directory) {
  try {
    return new Set(
      (await readdir(directory)).map((name) => name.toLowerCase()),
    );
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return new Set();
    throw error;
  }
}

/**
 * Scan a layout.
 *
 * @param {{root: string, system: Set<string>, system32x86?: Set<string>,
 *   reference?: Set<string>, ignore?: string[]}} options `system` holds the lower-case
 *   DLL names of the clean machine's System32 (`system32x86` its SysWOW64 for 32-bit images).
 * @returns {Promise<object>} JSON-serializable report (see the module comment).
 */
export async function scanLayout(options) {
  const root = path.resolve(options.root);
  const ignored = new Set((options.ignore ?? []).map((n) => n.toLowerCase()));
  const files = [];
  const index = new Map(); // lower-case file name -> relative directories
  const listing = new Map(); // relative directory -> Set of lower-case names
  for await (const relative of walk(root, ignored)) {
    const directory = path.dirname(relative);
    const name = path.basename(relative).toLowerCase();
    if (!listing.has(directory)) listing.set(directory, new Set());
    listing.get(directory).add(name);
    if (name.endsWith(".dll")) {
      if (!index.has(name)) index.set(name, []);
      index.get(name).push(directory);
    }
    if (peExtensions.has(path.extname(name))) files.push(relative);
  }
  const nodeRuntimeDirectories = [...listing.entries()]
    .filter(([, names]) => names.has("node.exe"))
    .map(([directory]) => directory);
  const resolve = (importer, machine, dll) => {
    if (isApiSet(dll)) return "api-set";
    const name = dll.toLowerCase();
    const directory = path.dirname(importer);
    if (listing.get(directory)?.has(name)) return "app-local";
    const system =
      machine === "x86" && options.system32x86
        ? options.system32x86
        : options.system;
    if (system.has(name)) return "system";
    // path.dirname ends at "." for relative paths, which is the layout root here.
    for (let at = directory; at !== ".";) {
      at = path.dirname(at);
      if (listing.get(at)?.has(name)) return `host-directory:${at}`;
    }
    if (
      importer.toLowerCase().endsWith(".node") &&
      nodeRuntimeDirectories.some((runtime) => listing.get(runtime)?.has(name))
    )
      return "node-runtime-directory";
    if (index.has(name)) return `elsewhere:${index.get(name)[0]}`;
    return "missing";
  };

  const report = {
    schemaVersion: 1,
    root,
    peFiles: 0,
    unreadable: [],
    machines: {},
    runtime: {},
    missing: {},
    elsewhere: {},
  };
  const add = (bucket, dll, importer, resolution) => {
    const key = dll.toLowerCase();
    bucket[key] ??= { importers: 0, resolutions: {}, examples: [] };
    const entry = bucket[key];
    entry.importers += 1;
    const kind = resolution.split(":")[0];
    entry.resolutions[kind] = (entry.resolutions[kind] ?? 0) + 1;
    if (entry.examples.length < 12)
      entry.examples.push({ file: importer.replaceAll("\\", "/"), resolution });
  };
  for (const relative of files) {
    let image;
    try {
      image = await readPeImports(path.join(root, relative));
    } catch (error) {
      if (!(error instanceof PeFormatError)) throw error;
      report.unreadable.push({
        file: relative.replaceAll("\\", "/"),
        error: error.message,
      });
      continue;
    }
    if (!image) continue;
    report.peFiles += 1;
    report.machines[image.machine] = (report.machines[image.machine] ?? 0) + 1;
    for (const [dll, delayed] of [
      ...image.imports.map((name) => [name, false]),
      ...image.delayImports.map((name) => [name, true]),
    ]) {
      const resolution = resolve(relative, image.machine, dll);
      if (isRedistributableRuntime(dll))
        add(report.runtime, dll, relative, resolution);
      if (resolution === "missing") {
        add(
          report.missing,
          dll,
          relative,
          delayed ? "missing (delay-load)" : "missing",
        );
        const known = options.reference?.has(dll.toLowerCase());
        report.missing[dll.toLowerCase()].classification =
          known === undefined
            ? "unknown"
            : known
              ? "windows-component-absent-on-the-clean-system"
              : "found-nowhere";
      } else if (resolution.startsWith("elsewhere:"))
        add(report.elsewhere, dll, relative, resolution);
    }
  }
  const risky = Object.entries(report.runtime).filter(
    ([, entry]) => entry.resolutions.missing || entry.resolutions.elsewhere,
  );
  report.runtimeAtRisk = risky.map(([dll]) => dll);
  report.status = risky.length ? "RISK" : "OK";
  return report;
}

/** Markdown summary of a {@link scanLayout} report. */
export function summarize(report) {
  const lines = [
    "### Native dependency scan (static, PE import tables)",
    "",
    `PE files: ${report.peFiles} (${Object.entries(report.machines)
      .map(([machine, count]) => `${machine} ${count}`)
      .join(
        ", ",
      )}); unreadable: ${report.unreadable.length}. Result: **${report.status}**.`,
    "",
    "| Redistributable runtime DLL | Importers | How importers resolve it |",
    "|---|---|---|",
  ];
  const runtime = Object.entries(report.runtime).sort();
  for (const [dll, entry] of runtime)
    lines.push(
      `| ${dll} | ${entry.importers} | ${Object.entries(entry.resolutions)
        .map(([kind, count]) => `${kind} ${count}`)
        .join(", ")} |`,
    );
  if (!runtime.length) lines.push("| (none imported) | 0 | - |");
  const missing = Object.entries(report.missing).sort();
  lines.push(
    "",
    `Imports that no searched location provides: ${missing.length}.`,
  );
  if (missing.length) {
    lines.push(
      "",
      "| DLL | Importers | Classification | Example |",
      "|---|---|---|---|",
    );
    for (const [dll, entry] of missing.slice(0, 60))
      lines.push(
        `| ${dll} | ${entry.importers} | ${entry.classification} | ${entry.examples[0].file} (${entry.examples[0].resolution}) |`,
      );
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const usage =
    "Usage: node scripts/check-bundle-native-deps.mjs --root DIR (--system32 DIR | --system-list FILE) [--reference-list FILE] [--out FILE] [--summary FILE] [--strict] [--ignore state,logs]";
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        root: { type: "string" },
        system32: { type: "string" },
        "system-list": { type: "string" },
        "reference-list": { type: "string" },
        out: { type: "string" },
        summary: { type: "string" },
        strict: { type: "boolean", default: false },
        ignore: { type: "string", default: "state,logs" },
        help: { type: "boolean", default: false },
      },
    }));
  } catch (error) {
    console.error(error.message);
    console.error(usage);
    return 2;
  }
  if (values.help) {
    console.log(usage);
    return 0;
  }
  if (
    !values.root ||
    Boolean(values.system32) === Boolean(values["system-list"])
  ) {
    console.error(usage);
    return 2;
  }
  const system = values.system32
    ? await directoryNames(values.system32)
    : await nameList(values["system-list"]);
  if (!system.size) {
    console.error("The clean system DLL list is empty");
    return 2;
  }
  const system32x86 = values.system32
    ? await directoryNames(path.join(path.dirname(values.system32), "SysWOW64"))
    : undefined;
  const report = await scanLayout({
    root: values.root,
    system,
    ...(system32x86?.size ? { system32x86 } : {}),
    ...(values["reference-list"]
      ? { reference: await nameList(values["reference-list"]) }
      : {}),
    ignore: values.ignore.split(",").filter(Boolean),
  });
  if (values.out)
    await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
  const summary = summarize(report);
  if (values.summary) await appendFile(values.summary, `\n${summary}`);
  console.log(summary);
  return values.strict && report.status !== "OK" ? 1 : 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await main();
