#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Build the HarnessHub single executable for the current platform (SEA feasibility spike,
 * OSS-008). Run after `pnpm build` and `pnpm build:console`; the result goes to dist/sea/.
 *
 * Usage: node tools/sea/build.mjs [--out dist/sea]
 *
 * Steps: esbuild bundles tools/sea/entry.mjs with the `hh` command table (apps/hh) and every
 * command it dispatches, the Worker, the command MCP and the engine launchers into one
 * CommonJS script, rewriting `import.meta.url` of every module to its repository-relative
 * location under the runtime extraction root (see entry.mjs); files read from disk become
 * SEA assets; `node --experimental-sea-config` writes the blob (with V8 code cache); postject
 * injects it into a copy of this Node executable; macOS gets an ad-hoc signature. Finally every
 * `hh` command must answer `--help` from the built executable, with a private HOME and
 * extraction root. `build.json` records sizes, inputs and that check.
 *
 * Fails when Node does not match .node-version (the binary is a copy of process.execPath),
 * when dist/ or the console build is missing, when any bundled module keeps an `import.meta`
 * use the rewrite does not cover, when entry.mjs and ROLE_ENTRIES disagree, when an asset
 * directory holds a script SCRIPT_ASSETS does not classify, or when the executable does not
 * run one of the `hh` commands.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import * as esbuild from "esbuild";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const BUILD_ID_PLACEHOLDER = "HARNESSHUB-SEA-BUILD-ID-PLACEHOLDER";
/**
 * The plain scripts of the asset directories, by repository-relative path, and
 * how the executable carries each: `role`, bundled and dispatched when a child
 * is started with its path (a placeholder file stands at that path); `file`,
 * extracted as it is, for a program that reads or runs it from disk with no
 * imports but Node's (Pi loads its extension, the Copilot host runs in
 * node-compat mode); `bundled`, imported by roles only and never run by path.
 * A new script in these directories fails the build until it is listed here.
 */
export const SCRIPT_ASSETS = {
  "packages/agents/assets/launch-engine.mjs": "role",
  "packages/agents/assets/launch-dsh-acp.mjs": "role",
  "packages/agents/assets/launch-openclaw-acp.mjs": "role",
  "packages/agents/assets/launch-opencode-acp.mjs": "role",
  "packages/agents/assets/launch-pi-acp.mjs": "role",
  "packages/agents/assets/spawn-engine.mjs": "bundled",
  "packages/agents/assets/native-mcp/pi-extension.mjs": "file",
  "packages/daemon/assets/copilot-host.mjs": "file",
};
const SCRIPT_DIRECTORIES = ["packages/agents/assets", "packages/daemon/assets"];

const ROLE_ENTRIES = [
  "packages/daemon/dist/src/main.js",
  "packages/daemon/dist/src/worker/main.js",
  "packages/daemon/dist/src/command-mcp-main.js",
  "packages/runtime/dist/src/process/proc-scan-main.js",
  ...Object.keys(SCRIPT_ASSETS).filter(
    (relative) => SCRIPT_ASSETS[relative] === "role",
  ),
];

/**
 * The role entries entry.mjs dispatches (its `ROLES` map), which must be
 * ROLE_ENTRIES. A role missing there makes the child run a placeholder (the
 * Linux process-table scanner once failed this way, leaving every crash
 * recovery `unconfirmed`).
 *
 * @param {string} entrySource The text of entry.mjs.
 * @param {readonly string[]} roles ROLE_ENTRIES.
 * @throws {Error} When the two lists differ.
 */
export function checkRoles(entrySource, roles) {
  const dispatched = [
    ...entrySource.matchAll(/\[\s*"([^"]+)",\s*\(\) => import\(/g),
  ].map((match) => match[1]);
  if (
    dispatched.length !== roles.length ||
    dispatched.some((role) => !roles.includes(role))
  )
    throw new Error(
      `tools/sea/entry.mjs dispatches [${dispatched.join(", ")}] but the build extracts [${roles.join(", ")}]`,
    );
}
checkRoles(
  readFileSync(path.join(ROOT, "tools/sea/entry.mjs"), "utf8"),
  ROLE_ENTRIES,
);
/**
 * Native helpers the executable may embed, by directory relative to the
 * repository. A migration step that moves or adds a helper updates this table.
 */
export const NATIVE_HELPERS = {
  // No helper is built into the root dist/native any more; a file there is stale.
  "dist/native": [],
  "packages/runtime/dist/native": ["harnesshub-job.exe"],
  "packages/secrets/dist/native": [
    "harnesshub-keychain",
    "harnesshub-secrets.exe",
  ],
  "packages/store/dist/native": ["harnesshub-acl.exe"],
};

/**
 * The native helpers to embed: every file of dist/native and of each
 * packages/<name>/dist/native, at its repository-relative path, where the
 * bundled modules resolve it from their own location under the extraction
 * root. Helpers absent on this platform are simply not embedded.
 *
 * @param {string} root Repository root.
 * @returns {{path: string, file: string}[]} Sorted by path.
 * @throws {Error} When a native directory holds a file NATIVE_HELPERS does not
 *   list, such as a stale helper from an earlier build, so it is never shipped.
 */
export function nativeAssets(root) {
  const packages = path.join(root, "packages");
  const directories = [
    "dist/native",
    ...(existsSync(packages) ? readdirSync(packages).sort() : []).map(
      (name) => `packages/${name}/dist/native`,
    ),
  ];
  const helpers = [];
  const unknown = [];
  for (const relative of directories) {
    const directory = path.join(root, ...relative.split("/"));
    if (!existsSync(directory)) continue;
    const allowed = NATIVE_HELPERS[relative] ?? [];
    for (const name of readdirSync(directory).sort())
      if (allowed.includes(name))
        helpers.push({
          path: `${relative}/${name}`,
          file: path.join(directory, name),
        });
      else unknown.push(`${relative}/${name}`);
  }
  if (unknown.length)
    throw new Error(
      `Native helper directories hold files NATIVE_HELPERS does not list: ${unknown.join(", ")}. Delete stale helpers, or list a new helper in tools/sea/build.mjs.`,
    );
  return helpers;
}

/**
 * The `file` scripts of SCRIPT_ASSETS, at their repository-relative paths under
 * the extraction root.
 *
 * @param {string} root Repository root.
 * @param {Readonly<Record<string, "role" | "file" | "bundled">>} [table] SCRIPT_ASSETS.
 * @returns {{path: string, file: string}[]} Sorted by path.
 * @throws {Error} When an asset directory holds a file the table does not
 *   list, or a listed file is missing.
 */
export function scriptAssets(root, table = SCRIPT_ASSETS) {
  const found = [];
  for (const relative of SCRIPT_DIRECTORIES) {
    const directory = path.join(root, ...relative.split("/"));
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, {
      recursive: true,
      withFileTypes: true,
    }))
      if (entry.isFile())
        found.push(
          `${relative}/${path
            .relative(directory, path.join(entry.parentPath, entry.name))
            .split(path.sep)
            .join("/")}`,
        );
  }
  const unknown = found.filter((relative) => !Object.hasOwn(table, relative));
  if (unknown.length)
    throw new Error(
      `Asset directories hold scripts SCRIPT_ASSETS does not classify: ${unknown.sort().join(", ")}. List each in tools/sea/build.mjs as a role, a file or bundled.`,
    );
  const missing = Object.keys(table).filter(
    (relative) => !found.includes(relative),
  );
  if (missing.length)
    throw new Error(
      `SCRIPT_ASSETS lists scripts that do not exist: ${missing.sort().join(", ")}`,
    );
  return found
    .filter((relative) => table[relative] === "file")
    .sort()
    .map((relative) => ({
      path: relative,
      file: path.join(root, ...relative.split("/")),
    }));
}

/**
 * Check that the built executable runs every `hh` command: each must answer
 * `<command> --help` with exit code 0. A command the executable does not
 * dispatch, did not bundle or cannot load fails here instead of at a user's
 * first try.
 *
 * @param {readonly string[]} names The commands of apps/hh (`COMMAND_NAMES`).
 * @param {(name: string) => {status: number | null, stderr: string, ms: number}} run
 *   Runs `<binary> <name> --help`.
 * @returns {Record<string, number>} Milliseconds per command.
 * @throws {Error} Naming every command that failed, with its exit status and
 *   the first line of its stderr.
 */
export function checkCommands(names, run) {
  if (!names.length) throw new Error("apps/hh lists no commands");
  const timings = {};
  const failed = [];
  for (const name of names) {
    const result = run(name);
    timings[name] = Math.round(result.ms);
    if (result.status !== 0)
      failed.push(
        `${name} (exit ${result.status}: ${result.stderr.trim().split("\n")[0] ?? ""})`,
      );
  }
  if (failed.length)
    throw new Error(
      `The executable does not run these hh commands: ${failed.join("; ")}`,
    );
  return timings;
}

/**
 * The provider presets the gateway reads from disk next to its compiled module
 * (packages/gateway/src/presets.ts): every packages/gateway/presets/*.json and
 * the license of the Magpie data in them, at its repository-relative path
 * under the extraction root.
 *
 * @param {string} root Repository root.
 * @returns {{path: string, file: string}[]} Sorted by path.
 */
export function presetAssets(root) {
  const relative = "packages/gateway/presets";
  const directory = path.join(root, ...relative.split("/"));
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    // magpie.LICENSE: the presets carry data taken from Magpie (MIT).
    .filter((name) => name.endsWith(".json") || name === "magpie.LICENSE")
    .sort()
    .map((name) => ({
      path: `${relative}/${name}`,
      file: path.join(directory, name),
    }));
}

/**
 * The model catalog snapshot the gateway reads next to its compiled module
 * (packages/gateway/src/catalog.ts) and the models.dev license that ships
 * with it, at their repository-relative paths.
 *
 * @param {string} root Repository root.
 * @returns {{path: string, file: string}[]} Sorted by path.
 */
export function catalogAssets(root) {
  const relative = "packages/gateway/catalog";
  const directory = path.join(root, ...relative.split("/"));
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(
      (name) =>
        name.startsWith("models-dev.") && /\.(json|LICENSE)$/.test(name),
    )
    .sort()
    .map((name) => ({
      path: `${relative}/${name}`,
      file: path.join(directory, name),
    }));
}

/**
 * The built console the daemon serves (packages/console/assets.mjs points at
 * packages/console/dist): every file of the build, at its repository-relative
 * path under the extraction root.
 *
 * @param {string} root Repository root.
 * @returns {{path: string, file: string}[]} Sorted by path.
 * @throws {Error} When the console is not built (no dist/index.html): an
 *   executable without it would serve a 503 page.
 */
export function consoleAssets(root) {
  const relative = "packages/console/dist";
  const directory = path.join(root, ...relative.split("/"));
  if (!existsSync(path.join(directory, "index.html")))
    throw new Error(`${relative}/index.html is missing; run pnpm build:console first`);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return {
        path: `${relative}/${path.relative(directory, file).split(path.sep).join("/")}`,
        file,
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const ROLE_PLACEHOLDER = `// Placeholder for a HarnessHub single-executable role entry. The executable that wrote this
// directory runs the bundled role when it is started with this path; nothing else may run it.
throw new Error("HarnessHub single-executable role placeholder; start it through the executable");
`;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const relativeToRoot = (file) =>
  path.relative(ROOT, file).split(path.sep).join("/");

/**
 * jsonc-parser's main build is UMD: its factory requires "./impl/format"
 * through its own `require` argument, which esbuild cannot follow, so the
 * bundled `require` fails at run time. Its ESM build (its `module` field)
 * bundles normally.
 */
const esmBuildPlugin = {
  name: "harnesshub-sea-esm-build",
  setup(build) {
    build.onResolve({ filter: /^jsonc-parser$/ }, (args) => {
      const manifest = createRequire(path.join(args.resolveDir, "index.js")).resolve(
        "jsonc-parser/package.json",
      );
      const { module } = JSON.parse(readFileSync(manifest, "utf8"));
      return { path: path.join(path.dirname(manifest), module) };
    });
  },
};

/** Rewrites `import.meta.url` per module; see entry.mjs for the runtime half. */
const moduleUrlPlugin = {
  name: "harnesshub-sea-module-url",
  setup(build) {
    build.onLoad({ filter: /\.(?:m?js|cjs)$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      if (!source.includes("import.meta")) return undefined;
      const relative = relativeToRoot(args.path);
      if (relative.startsWith("../"))
        throw new Error(`Bundled module outside the repository: ${args.path}`);
      return {
        contents: source.replaceAll(
          "import.meta.url",
          `globalThis.__harnesshubSeaModuleUrl(${JSON.stringify(relative)})`,
        ),
        loader: "js",
      };
    });
  },
};

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

/**
 * Run `<binary> <command> --help` for every command of apps/hh with a private
 * HOME, temporary directory and extraction root under `out`, removed after.
 */
async function probeCommands(binary, out) {
  const { COMMAND_NAMES } = await import(
    new URL("../../apps/hh/dist/src/main.js", import.meta.url).href
  );
  const directory = path.join(out, "command-probe");
  mkdirSync(path.join(directory, "home"), { recursive: true });
  mkdirSync(path.join(directory, "tmp"), { recursive: true });
  const env = {
    PATH: process.env.PATH ?? "",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: path.join(directory, "home"),
    USERPROFILE: path.join(directory, "home"),
    LOCALAPPDATA: path.join(directory, "home", "AppData", "Local"),
    XDG_CACHE_HOME: path.join(directory, "home", ".cache"),
    TMPDIR: path.join(directory, "tmp"),
    TEMP: path.join(directory, "tmp"),
    TMP: path.join(directory, "tmp"),
    HARNESSHUB_SEA_ROOT: path.join(directory, "root"),
    HH_OFFLINE: "1",
  };
  try {
    return checkCommands(COMMAND_NAMES, (name) => {
      const started = performance.now();
      const result = spawnSync(binary, [name, "--help"], {
        cwd: directory,
        env,
        encoding: "utf8",
        timeout: 60_000,
      });
      if (result.error) throw result.error;
      return { ...result, ms: performance.now() - started };
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Group bundled input bytes by package (or by src/ top directory) for the size breakdown. */
function inputBreakdown(metafile) {
  const groups = new Map();
  for (const [file, input] of Object.entries(metafile.inputs)) {
    const match =
      /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(
        file,
      );
    const key = match
      ? match[1]
      : file.startsWith("packages/")
        ? `harnesshub:${file.split("/")[1]}`
        : `harnesshub:${file}`;
    groups.set(key, (groups.get(key) ?? 0) + input.bytes);
  }
  return Object.fromEntries([...groups].sort((a, b) => b[1] - a[1]));
}

export async function buildSea({ out = path.join(ROOT, "dist", "sea") } = {}) {
  const expectedNode = readFileSync(
    path.join(ROOT, ".node-version"),
    "utf8",
  ).trim();
  if (process.versions.node !== expectedNode)
    throw new Error(
      `Node ${expectedNode} is required; found ${process.versions.node}`,
    );
  const buildInfoFile = path.join(
    ROOT,
    "packages",
    "daemon",
    "dist",
    "build-info.json",
  );
  if (
    !existsSync(buildInfoFile) ||
    !existsSync(path.join(ROOT, "packages", "daemon", "dist", "src", "main.js"))
  )
    throw new Error("dist/ is missing; run pnpm build first");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // Files other programs read from disk, extracted under the runtime root.
  const buildInfo = JSON.parse(readFileSync(buildInfoFile, "utf8"));
  const assets = new Map([
    [
      "packages/daemon/dist/build-info.json",
      {
        bytes: Buffer.from(
          `${JSON.stringify({ ...buildInfo, installMethod: "sea" }, null, 2)}\n`,
        ),
        executable: false,
      },
    ],
    [
      // hh benchmark records the daemon's version from it.
      "packages/daemon/package.json",
      {
        bytes: readFileSync(path.join(ROOT, "packages", "daemon", "package.json")),
        executable: false,
      },
    ],
  ]);
  for (const helper of nativeAssets(ROOT))
    assets.set(helper.path, {
      bytes: readFileSync(helper.file),
      executable: true,
    });
  for (const data of [
    // The Copilot host runs by path with this executable as Node: it imports
    // the optional Copilot SDK add-on, which cannot be bundled.
    ...scriptAssets(ROOT),
    ...presetAssets(ROOT),
    ...catalogAssets(ROOT),
    ...consoleAssets(ROOT),
  ])
    assets.set(data.path, {
      bytes: readFileSync(data.file),
      executable: false,
    });
  const placeholder = Buffer.from(ROLE_PLACEHOLDER);
  const files = [
    ...[...assets].map(([relative, { bytes, executable }]) => ({
      path: relative,
      asset: relative,
      sha256: sha256(bytes),
      size: bytes.length,
      executable,
    })),
    ...ROLE_ENTRIES.map((relative) => ({
      path: relative,
      asset: "role-placeholder.js",
      sha256: sha256(placeholder),
      size: placeholder.length,
      executable: false,
    })),
  ];

  const bundled = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ["tools/sea/entry.mjs"],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    write: false,
    metafile: true,
    legalComments: "none",
    outfile: path.join(out, "harnesshub-sea.cjs"),
    define: {
      __HH_SEA_BUILD_ID__: JSON.stringify(BUILD_ID_PLACEHOLDER),
      __HH_SEA_FILES__: JSON.stringify(files),
    },
    plugins: [esmBuildPlugin, moduleUrlPlugin],
    logLevel: "warning",
    logOverride: { "empty-import-meta": "error" },
  });
  const [output] = bundled.outputFiles;
  const hash = createHash("sha256").update(output.text);
  for (const file of files) hash.update(`${file.path}\0${file.sha256}\0`);
  const buildId = hash.digest("hex").slice(0, 16);
  const quoted = JSON.stringify(BUILD_ID_PLACEHOLDER);
  if (!output.text.includes(quoted))
    throw new Error("Build ID placeholder missing from the bundle");
  const bundle = output.text.replaceAll(quoted, JSON.stringify(buildId));
  const bundleFile = path.join(out, "harnesshub-sea.cjs");
  writeFileSync(bundleFile, bundle);

  const assetDirectory = path.join(out, "assets");
  const seaAssets = {};
  for (const [relative, { bytes }] of assets) {
    const file = path.join(assetDirectory, ...relative.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    seaAssets[relative] = file;
  }
  const placeholderFile = path.join(assetDirectory, "role-placeholder.js");
  writeFileSync(placeholderFile, placeholder);
  seaAssets["role-placeholder.js"] = placeholderFile;

  const blobFile = path.join(out, "sea-prep.blob");
  const configFile = path.join(out, "sea-config.json");
  writeFileSync(
    configFile,
    `${JSON.stringify(
      {
        main: bundleFile,
        output: blobFile,
        disableExperimentalSEAWarning: true,
        useCodeCache: true,
        assets: seaAssets,
      },
      null,
      2,
    )}\n`,
  );
  run(process.execPath, ["--experimental-sea-config", configFile]);

  const binary = path.join(
    out,
    process.platform === "win32" ? "harnesshub.exe" : "harnesshub",
  );
  copyFileSync(process.execPath, binary);
  chmodSync(binary, 0o755);
  if (process.platform === "darwin")
    run("codesign", ["--remove-signature", binary]);
  const { inject } = require("postject");
  await inject(binary, "NODE_SEA_BLOB", readFileSync(blobFile), {
    sentinelFuse: SENTINEL_FUSE,
    ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
  });
  if (process.platform === "darwin") run("codesign", ["--sign", "-", binary]);
  const commands = await probeCommands(binary, out);

  const record = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    esbuild: esbuild.version,
    buildId,
    commit: buildInfo.commit,
    dirty: buildInfo.dirty,
    binary: path.relative(ROOT, binary).split(path.sep).join("/"),
    sizes: {
      nodeRuntime: statSync(process.execPath).size,
      bundle: Buffer.byteLength(bundle),
      assets: Object.fromEntries(
        files.filter((f) => f.asset === f.path).map((f) => [f.path, f.size]),
      ),
      blob: statSync(blobFile).size,
      binary: statSync(binary).size,
      // Download-size estimate; release archives are tar.gz (zip on Windows).
      binaryGzip9: gzipSync(readFileSync(binary), { level: 9 }).length,
    },
    // SHA-256 of every embedded asset, which measure.mjs compares with the
    // extracted files.
    assetSha256: Object.fromEntries(
      files.filter((f) => f.asset === f.path).map((f) => [f.path, f.sha256]),
    ),
    bundleInputs: inputBreakdown(bundled.metafile),
    // Milliseconds each `hh <command> --help` took from the built executable.
    commandHelpMs: commands,
  };
  writeFileSync(
    path.join(out, "build.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  try {
    const record = await buildSea(
      values.out ? { out: path.resolve(values.out) } : {},
    );
    console.log(
      JSON.stringify({
        event: "sea.built",
        binary: record.binary,
        buildId: record.buildId,
        sizes: { ...record.sizes, assets: undefined },
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
