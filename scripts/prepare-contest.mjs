/** Developer-machine preparation only. This file is never a judge startup path. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { machine } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse } from "yaml";

const repo = fileURLToPath(new URL("../", import.meta.url));
const nodeVersion = "24.20.0";
const pnpmVersion = "10.12.3";
const help =
  "Developer only: node scripts/prepare-contest.mjs [--root CHECKOUT/.tools/PREPARED] [--arch arm64|x64] [--pnpm ABSOLUTE_PNPM_JS] [--check]\n--check validates existing prepared inputs without downloads, installs or catalog writes.";
const missing = (error) => error?.code === "ENOENT";

export function preparationOptions(
  args,
  host = {
    platform: process.platform,
    arch: process.arch,
    version: process.versions.node,
    machine: machine(),
  },
) {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      root: { type: "string" },
      arch: { type: "string", default: host.arch },
      pnpm: { type: "string" },
      check: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return { help: true };
  const architecture = {
    arm64: "arm64",
    aarch64: "arm64",
    x64: "x64",
    x86_64: "x64",
    amd64: "x64",
  }[host.machine.toLowerCase()];
  if (
    host.platform !== "win32" ||
    host.version !== nodeVersion ||
    !["arm64", "x64"].includes(values.arch) ||
    values.arch !== host.arch ||
    values.arch !== architecture
  )
    throw new Error(
      `Use native Windows ${values.arch} Node ${nodeVersion}; cross-architecture preparation is not supported`,
    );
  const root = path.resolve(
    values.root ??
      path.join(repo, ".tools/contest-prepared", `win32-${values.arch}`),
  );
  const relative = path.relative(repo, root).split(path.sep);
  if (
    ![".tools", ".tmp"].includes(relative[0]) ||
    relative.length < 2 ||
    relative.includes("..")
  )
    throw new Error(
      "Preparation root must be a child of this checkout's .tools or .tmp directory",
    );
  if (
    values.pnpm &&
    (!path.isAbsolute(values.pnpm) || !/\.[cm]?js$/i.test(values.pnpm))
  )
    throw new Error(
      "--pnpm must name an absolute pnpm JavaScript entry; .cmd/global temporary shims are not used",
    );
  return {
    root,
    arch: values.arch,
    check: values.check,
    pnpm:
      values.pnpm ??
      path.join(
        path.dirname(process.execPath),
        "node_modules/corepack/dist/pnpm.js",
      ),
  };
}
async function ordinary(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Expected ordinary prepared file: ${file}`);
  return info;
}
async function directory(location, create = false) {
  const absolute = path.resolve(location);
  let current = path.parse(absolute).root;
  const names = [current];
  for (const part of absolute
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    names.push(current);
  }
  for (const name of names) {
    let info;
    try {
      info = await lstat(name);
    } catch (error) {
      if (!create || !missing(error)) throw error;
      await mkdir(name);
      info = await lstat(name);
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Preparation directory cannot follow links: ${name}`);
  }
}
async function digest(file) {
  await ordinary(file);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
async function equalFile(source, target) {
  if ((await digest(source)) !== (await digest(target)))
    throw new Error(`Prepared file differs from its fixed input: ${target}`);
}
async function execute(
  executable,
  args,
  { cwd = repo, capture = false, network = true } = {},
) {
  const child = spawn(executable, args, {
    cwd,
    windowsHide: true,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: {
      ...process.env,
      PATH: [path.dirname(process.execPath), process.env.PATH ?? ""].join(
        path.delimiter,
      ),
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      COREPACK_ENABLE_NETWORK: network ? "1" : "0",
      COREPACK_ENABLE_STRICT: "1",
      COREPACK_ENABLE_PROJECT_SPEC: "1",
    },
  });
  let stdout = "",
    stderr = "";
  if (capture)
    for (const [stream, target] of [
      [child.stdout, "out"],
      [child.stderr, "err"],
    ])
      stream.on("data", (bytes) => {
        if (target === "out") stdout += bytes;
        else stderr += bytes;
        if (stdout.length + stderr.length > 65536) child.kill();
      });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0)
    throw new Error(
      `Preparation command failed (${code}): ${path.basename(executable)} ${args[0] ?? ""}${capture ? `; ${stderr.slice(0, 2000)}` : ""}`,
    );
  return stdout.trim();
}
export function preparationSteps(
  root,
  arch,
  pnpmEntry,
  node = process.execPath,
) {
  const npm = path.join(root, "engines/npm");
  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  return [
    {
      id: "npm",
      executable: node,
      cwd: npm,
      args: [
        pnpmEntry,
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--ignore-workspace",
        "--config.node-linker=hoisted",
        "--package-import-method=copy",
        "--prod",
      ],
    },
    {
      id: "binaries",
      executable: node,
      args: [
        path.join(repo, "scripts/prepare-binaries.mjs"),
        "--root",
        root,
        "--arch",
        arch,
      ],
    },
    ...["hermes", "kiro"].map((engine) => ({
      id: engine,
      executable: powershell,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(repo, "scripts/prepare-extra-engines.ps1"),
        "-TargetRoot",
        root,
        "-Engine",
        engine,
      ],
    })),
    {
      id: "git",
      executable: node,
      args: [
        path.join(repo, "scripts/prepare-git.mjs"),
        "--root",
        root,
        "--arch",
        arch,
      ],
    },
    {
      id: "openclaw",
      executable: node,
      args: [
        path.join(repo, "scripts/prepare-openclaw.mjs"),
        "--package",
        path.join(npm, "node_modules/openclaw"),
      ],
    },
    {
      id: "catalog",
      executable: node,
      args: [
        path.join(repo, "scripts/prepare-engine-catalog.mjs"),
        "--root",
        root,
        "--arch",
        arch,
      ],
    },
  ];
}
async function npmInputs(root) {
  const npm = path.join(root, "engines/npm");
  for (const name of ["package.json", "pnpm-lock.yaml"])
    await equalFile(
      path.join(repo, "distribution/npm", name),
      path.join(npm, name),
    );
  const expected = await json(path.join(repo, "distribution/npm/package.json"));
  if (expected.packageManager !== `pnpm@${pnpmVersion}`)
    throw new Error(
      "Distribution package manager pin changed; review preparation version",
    );
  const modules = parse(
    await readFile(path.join(npm, "node_modules/.modules.yaml"), "utf8"),
  );
  if (
    modules.nodeLinker !== "hoisted" ||
    modules.packageManager !== `pnpm@${pnpmVersion}`
  )
    throw new Error(
      "Prepared npm graph must use pinned pnpm with node-linker=hoisted",
    );
  for (const [name, version] of Object.entries(expected.dependencies)) {
    const installed = await json(
      path.join(npm, "node_modules", name, "package.json"),
    );
    if (installed.name !== name || installed.version !== version)
      throw new Error(
        `Prepared npm dependency differs from fixed version: ${name}`,
      );
  }
}
async function extra(root, id, arch) {
  const receipt = await json(path.join(root, "engines", id, "prepared.json"));
  if (
    receipt.sourceManifestSha256 !==
      (await digest(
        path.join(repo, "distribution/extra-engine-sources.json"),
      )) ||
    receipt.hostArchitecture !== arch ||
    receipt.modelRequests !== 0 ||
    receipt.version?.exitCode !== 0
  )
    throw new Error(
      `Existing ${id} preparation receipt is stale or incomplete; use a fresh preparation root`,
    );
  const required = id === "hermes" ? "runtime/python.exe" : "kiro-cli.exe";
  await ordinary(path.join(root, "engines", id, required));
  if (
    id === "hermes" &&
    (receipt.importCheck?.exitCode !== 0 ||
      receipt.nativeImportCheck?.exitCode !== 0)
  )
    throw new Error("Hermes preparation import checks are incomplete");
  if (id === "kiro" && receipt.machineInstallation !== false)
    throw new Error(
      "Kiro receipt does not confirm extraction without installation",
    );
}
async function binaries(root, arch) {
  const receipts = await json(path.join(root, "binary-receipts.json"));
  const sources = await json(
    path.join(repo, "distribution/binary-sources.json"),
  );
  if (!Array.isArray(receipts) || receipts.length !== sources.length)
    throw new Error("Binary receipts do not cover the fixed source set");
  for (const source of sources) {
    const target = source.targets[arch];
    const receipt = receipts.find((item) => item.id === source.id);
    if (
      !receipt ||
      receipt.version !== source.version ||
      receipt.source !== target.archive ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
      (target.sha256 && receipt.sha256 !== target.sha256)
    )
      throw new Error(`Binary receipt mismatch: ${source.id}`);
    const executable = receipt.command?.[0];
    if (
      typeof executable !== "string" ||
      !executable.startsWith(`\${bundle}/engines/${source.id}/`) ||
      executable.includes("..")
    )
      throw new Error("Binary receipt has an invalid entry");
    await ordinary(path.join(root, executable.slice("${bundle}/".length)));
  }
}
async function git(root) {
  const receipt = await json(path.join(root, "git-receipt.json"));
  if (
    receipt.version !== "2.55.0.windows.5" ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256)
  )
    throw new Error("PortableGit receipt is missing or incompatible");
  await ordinary(path.join(root, "bin/git/cmd/git.exe"));
  await ordinary(path.join(root, "bin/git/usr/bin/bash.exe"));
}
async function toolTree(source, target, copy = false) {
  await directory(source);
  if (copy) await directory(target, true);
  else await directory(target);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name),
      to = path.join(target, entry.name);
    if (entry.isDirectory()) await toolTree(from, to, copy);
    else {
      await ordinary(from);
      if (copy) {
        try {
          await ordinary(to);
        } catch (error) {
          if (!missing(error)) throw error;
        }
        await copyFile(from, to);
      } else await equalFile(from, to);
    }
  }
  const expected = (await readdir(source)).sort();
  if (
    JSON.stringify((await readdir(target)).sort()) !== JSON.stringify(expected)
  )
    throw new Error(
      "Prepared tool directory contains stale extra files; use a fresh preparation root",
    );
}
async function vendorNotices(root, copy = false) {
  const sources = path.join(repo, "distribution/vendor-notices");
  for (const entry of await readdir(sources, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-z][a-z0-9-]*$/.test(entry.name))
      throw new Error("Vendor notices must be ordinary engine directories");
    await toolTree(
      path.join(sources, entry.name),
      path.join(root, "engines", entry.name, "vendor-notices"),
      copy,
    );
  }
}
export async function verifyPreparation(root, arch) {
  await directory(root);
  await equalFile(process.execPath, path.join(root, "runtime/node.exe"));
  await equalFile(
    path.join(path.dirname(process.execPath), "LICENSE"),
    path.join(root, "runtime/LICENSE"),
  );
  await npmInputs(root);
  await binaries(root, arch);
  for (const id of ["hermes", "kiro"]) await extra(root, id, arch);
  await git(root);
  const openclaw = path.join(root, "engines/npm/node_modules/openclaw");
  for (const marker of [
    ".openclaw-lifecycle-pending",
    "dist/openclaw-install-guard",
  ]) {
    try {
      await lstat(path.join(openclaw, marker));
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    throw new Error("OpenClaw lifecycle is incomplete");
  }
  await toolTree(
    path.join(repo, "examples/tool-packages"),
    path.join(root, "tools"),
  );
  await vendorNotices(root);
  const catalog = await json(path.join(root, "prepared.json"));
  if (
    catalog.schemaVersion !== 1 ||
    catalog.platform !== "win32" ||
    catalog.arch !== arch ||
    catalog.nodeVersion !== nodeVersion ||
    !Array.isArray(catalog.engines) ||
    !catalog.engines.length
  )
    throw new Error("Prepared catalog is invalid");
  for (const engine of catalog.engines)
    for (const relative of engine.requiredFiles ?? []) {
      if (path.isAbsolute(relative) || relative.includes(".."))
        throw new Error("Invalid required engine path");
      await ordinary(
        path.join(relative.startsWith("scripts/") ? repo : root, relative),
      );
    }
  return {
    prepared: root,
    platform: "win32",
    arch,
    nodeVersion,
    pnpmVersion,
    engines: catalog.engines.length,
    checked: true,
    downloads: false,
    modelCalled: false,
  };
}
export async function prepareContest(args) {
  const options = preparationOptions(args);
  if (options.help) {
    console.log(help);
    return;
  }
  await ordinary(options.pnpm);
  const manager = await execute(process.execPath, [options.pnpm, "--version"], {
    capture: true,
    network: !options.check,
  });
  if (manager !== pnpmVersion)
    throw new Error(`Expected pnpm ${pnpmVersion}; found ${manager}`);
  if (options.check) {
    console.log(
      JSON.stringify(
        await verifyPreparation(options.root, options.arch),
        null,
        2,
      ),
    );
    return;
  }
  await directory(options.root, true);
  const lock = path.join(options.root, ".prepare-contest-lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Another preparation owns this root; inspect .prepare-contest-lock and confirm its owner has stopped before explicit recovery",
      );
    throw error;
  }
  const owned = await lstat(lock, { bigint: true });
  let started = false,
    complete = false;
  try {
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { flag: "wx" },
    );
    const previous = path.join(options.root, "prepared.json");
    try {
      await ordinary(previous);
      await rename(
        previous,
        path.join(options.root, `prepared.previous.${randomUUID()}.json`),
      );
    } catch (error) {
      if (!missing(error)) throw error;
    }
    started = true;
    await directory(path.join(options.root, "runtime"), true);
    for (const name of ["node.exe", "LICENSE"]) {
      const from =
        name === "node.exe"
          ? process.execPath
          : path.join(path.dirname(process.execPath), name);
      const to = path.join(options.root, "runtime", name);
      try {
        await equalFile(from, to);
      } catch (error) {
        if (!missing(error)) throw error;
        await copyFile(from, to, constants.COPYFILE_EXCL);
      }
    }
    const npm = path.join(options.root, "engines/npm");
    await directory(npm, true);
    for (const name of ["package.json", "pnpm-lock.yaml"]) {
      const target = path.join(npm, name);
      try {
        await ordinary(target);
      } catch (error) {
        if (!missing(error)) throw error;
      }
      await copyFile(path.join(repo, "distribution/npm", name), target);
    }
    for (const step of preparationSteps(
      options.root,
      options.arch,
      options.pnpm,
    )) {
      if (step.id === "catalog") {
        await toolTree(
          path.join(repo, "examples/tool-packages"),
          path.join(options.root, "tools"),
          true,
        );
        await vendorNotices(options.root, true);
      }
      let reused = false;
      const validate =
        step.id === "binaries"
          ? () => binaries(options.root, options.arch)
          : ["hermes", "kiro"].includes(step.id)
            ? () => extra(options.root, step.id, options.arch)
            : step.id === "git"
              ? () => git(options.root)
              : undefined;
      if (validate) {
        try {
          await validate();
          reused = true;
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      if (reused) console.log(`Reused verified ${step.id} preparation`);
      else {
        console.log(`Preparing ${step.id}`);
        await execute(
          step.executable,
          step.args,
          step.cwd ? { cwd: step.cwd } : {},
        );
      }
      if (step.id === "npm") await npmInputs(options.root);
    }
    const result = await verifyPreparation(options.root, options.arch);
    await writeFile(
      path.join(options.root, "preparation-receipt.json"),
      JSON.stringify(
        {
          ...result,
          checkedAt: new Date().toISOString(),
          downloads: "developer preparation may download fixed dependencies",
        },
        null,
        2,
      ) + "\n",
    );
    complete = true;
    console.log(
      JSON.stringify(
        {
          ...result,
          downloads: "developer preparation may download fixed dependencies",
        },
        null,
        2,
      ),
    );
  } finally {
    if (started && !complete) {
      try {
        await ordinary(path.join(options.root, "prepared.json"));
        await rename(
          path.join(options.root, "prepared.json"),
          path.join(options.root, `prepared.failed.${randomUUID()}.json`),
        );
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    await directory(options.root);
    const current = await lstat(lock, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== owned.dev ||
      current.ino !== owned.ino
    )
      throw new Error("Preparation lock was replaced; refusing to remove it");
    try {
      await unlink(path.join(lock, "owner.json"));
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await rmdir(lock);
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await prepareContest(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
