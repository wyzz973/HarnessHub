import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export function within(root, file) {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

/** Copy only owned source trees, materializing internal links without accepting cycles or special files. */
export async function copyTree(source, destination, options = {}) {
  const sourceRoot = await realpath(source);
  const allowedRoots = await Promise.all(
    (options.allowedRoots ?? [sourceRoot]).map((root) => realpath(root)),
  );
  if (within(sourceRoot, path.resolve(destination)))
    throw new Error("Bundle output must not be inside a copied source tree");
  let files = 0;
  async function copy(from, to, ancestors, relative) {
    if (options.filter && !options.filter(relative, path.basename(from)))
      return;
    const canonical = await realpath(from);
    if (!allowedRoots.some((root) => within(root, canonical)))
      throw new Error(
        `Bundle source link escapes its allowed roots: ${relative}`,
      );
    const info = await stat(canonical);
    if (info.isDirectory()) {
      if (ancestors.has(canonical))
        throw new Error(`Bundle source contains a link cycle: ${relative}`);
      const next = new Set(ancestors).add(canonical);
      await mkdir(to, { recursive: true });
      for (const entry of (await readdir(canonical)).sort())
        await copy(
          path.join(canonical, entry),
          path.join(to, entry),
          next,
          relative ? `${relative}/${entry}` : entry,
        );
    } else if (info.isFile()) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(canonical, to, 1);
      files++;
    } else
      throw new Error(
        `Bundle source is not a regular file or directory: ${relative}`,
      );
  }
  await copy(sourceRoot, destination, new Set(), "");
  return files;
}

const sensitiveNames = new Set([
  ".git",
  ".npmrc",
  ".pypirc",
  ".ds_store",
  ".modules.yaml",
  ".pnpm",
  ".pnpm-workspace-state-v1.json",
  "__pycache__",
]);
export function distributableFile(relative, name, arch) {
  if (arch !== undefined && !["arm64", "x64"].includes(arch))
    throw new Error("Bundle prebuild filtering requires Windows arm64 or x64");
  const segments = relative.replaceAll("\\", "/").split("/");
  for (let index = 0; index < segments.length - 1; index++) {
    if (
      arch &&
      segments[index].toLowerCase() === "prebuilds" &&
      /^(?:win32|darwin|linux(?:musl)?|android|freebsd|openbsd|aix|sunos)-[a-z0-9_-]+$/i.test(
        segments[index + 1],
      ) &&
      segments[index + 1].toLowerCase() !== `win32-${arch}`
    )
      return false;
  }
  return (
    !sensitiveNames.has(name.toLowerCase()) &&
    !/^\.env(?:\.|$)/i.test(name) &&
    !/\.(?:dpapi|sqlite(?:-wal|-shm)?|log|py[co])$/i.test(name)
  );
}

/** Next embeds its build directory in known metadata. Resolve runtime roots beside the relocated server instead. */
export async function relocateStandalone(
  server,
  traceRoot = path.dirname(server),
) {
  const source = await readFile(server, "utf8");
  const match = /^const nextConfig = (.+)$/m.exec(source);
  if (!match) throw new Error("Unsupported Next standalone server format");
  const config = JSON.parse(match[1]);
  const relativeRoot = path.relative(path.dirname(server), traceRoot) || ".";
  function portableConfig(value) {
    const result = { ...value };
    result.outputFileTracingRoot = relativeRoot;
    result.repoRoot = relativeRoot;
    if (result.turbopack)
      result.turbopack = { ...result.turbopack, root: relativeRoot };
    return result;
  }
  const replacement = `const nextConfig = ${JSON.stringify(portableConfig(config))}\nnextConfig.outputFileTracingRoot = path.resolve(__dirname, ${JSON.stringify(relativeRoot)})\nnextConfig.repoRoot = nextConfig.outputFileTracingRoot\nif (nextConfig.turbopack) nextConfig.turbopack.root = nextConfig.outputFileTracingRoot`;
  await writeFile(
    server,
    source.replace(match[0], () => replacement),
  );
  const manifest = path.join(
    path.dirname(server),
    ".next",
    "required-server-files.json",
  );
  const required = JSON.parse(await readFile(manifest, "utf8"));
  required.config = portableConfig(required.config);
  required.appDir = ".";
  await writeFile(manifest, JSON.stringify(required, null, 2) + "\n");
}

async function readPackage(directory) {
  const value = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
  if (!value || typeof value !== "object" || typeof value.name !== "string")
    throw new Error("Installed package metadata is invalid");
  return value;
}

async function resolvePackage(name, owner, allowedRoot) {
  const require = createRequire(path.join(owner, "package.json"));
  // A registry package may share a built-in name (for example string_decoder).
  // Resolve lookup directories through its package path, which is never a builtin.
  for (const directory of require.resolve.paths(`${name}/package.json`) ?? []) {
    const candidate = path.join(directory, name);
    try {
      const canonical = await realpath(candidate);
      if (!within(allowedRoot, canonical))
        throw new Error(
          `Dependency ${name} resolves outside the installed dependency root`,
        );
      await readPackage(canonical);
      return canonical;
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      throw error;
    }
  }
  throw Object.assign(
    new Error(`Installed production dependency ${name} is missing`),
    { code: "DEPENDENCY_MISSING" },
  );
}

function dependencies(manifest) {
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...(Array.isArray(manifest.bundledDependencies)
      ? manifest.bundledDependencies
      : []),
    ...(Array.isArray(manifest.bundleDependencies)
      ? manifest.bundleDependencies
      : []),
  ]);
  return [...names].sort().map((name) => ({
    name,
    optional:
      Object.hasOwn(manifest.optionalDependencies ?? {}, name) ||
      manifest.peerDependenciesMeta?.[name]?.optional === true,
  }));
}

/** Materialize the exact installed production graph, retaining version conflicts in nested Node scopes. No registry resolution or shims. */
export async function materializeNodeModules(
  packageDirectory,
  destination,
  options = {},
) {
  const allowedRoot = await realpath(
    options.allowedRoot ?? path.join(packageDirectory, "node_modules"),
  );
  const rootManifest = await readPackage(packageDirectory);
  if (options.includeDevelopment === true) {
    rootManifest.dependencies = {
      ...rootManifest.dependencies,
      ...rootManifest.devDependencies,
    };
  }
  const rootDependencies = dependencies({
    ...rootManifest,
    peerDependencies: {},
  });
  if (options.dependencies !== undefined) {
    if (
      !Array.isArray(options.dependencies) ||
      options.dependencies.length === 0 ||
      new Set(options.dependencies).size !== options.dependencies.length ||
      options.dependencies.some(
        (name) => !rootDependencies.some((entry) => entry.name === name),
      )
    )
      throw new Error(
        "Selected dependencies must be unique declared package dependencies",
      );
  }
  const rootScope = { directory: destination, bindings: new Map() };
  const queue = [];
  const components = new Map();
  function place(name, source, scope, parents) {
    if (scope.bindings.has(name))
      throw new Error(`Dependency scope already contains ${name}`);
    scope.bindings.set(name, source);
    queue.push({
      name,
      source,
      destination: path.join(scope.directory, name),
      scopes: [scope, ...parents],
    });
  }
  for (const entry of rootDependencies.filter(
    (entry) =>
      options.dependencies === undefined ||
      options.dependencies.includes(entry.name),
  )) {
    try {
      place(
        entry.name,
        await resolvePackage(entry.name, packageDirectory, allowedRoot),
        rootScope,
        [],
      );
    } catch (error) {
      if (!entry.optional || error.code !== "DEPENDENCY_MISSING") throw error;
    }
  }
  for (let index = 0; index < queue.length; index++) {
    if (queue.length > 10_000)
      throw new Error("Production dependency graph exceeds its package bound");
    const current = queue[index];
    const manifest = await readPackage(current.source);
    components.set(`${manifest.name}@${manifest.version}`, {
      id: `npm:${manifest.name}`,
      version: manifest.version,
      source: "pnpm-lock.yaml installed dependency graph",
      ...(typeof manifest.license === "string"
        ? { license: manifest.license }
        : {}),
    });
    await copyTree(current.source, current.destination, {
      allowedRoots: [allowedRoot],
      filter: (relative, name) =>
        relative !== "node_modules" &&
        !relative.startsWith("node_modules/") &&
        distributableFile(relative, name, options.arch),
    });
    const local = {
      directory: path.join(current.destination, "node_modules"),
      bindings: new Map(),
    };
    for (const entry of dependencies(manifest)) {
      let expected;
      try {
        expected = await resolvePackage(
          entry.name,
          current.source,
          allowedRoot,
        );
      } catch (error) {
        if (entry.optional && error.code === "DEPENDENCY_MISSING") continue;
        throw error;
      }
      const visible = [local, ...current.scopes].find((scope) =>
        scope.bindings.has(entry.name),
      );
      if (visible?.bindings.get(entry.name) === expected) continue;
      if (!visible) place(entry.name, expected, rootScope, []);
      else place(entry.name, expected, local, current.scopes);
    }
  }
  return [...components.values()].sort((a, b) =>
    `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`),
  );
}

/** Reject platform-incompatible Windows addons before they can hide behind lazy imports. */
export async function assertAddonArchitecture(file, arch) {
  const data = await readFile(file);
  if (data.length < 64 || data.readUInt16LE(0) !== 0x5a4d)
    throw new Error("Windows native addon is not a PE image");
  const offset = data.readUInt32LE(0x3c);
  if (offset > data.length - 6 || data.readUInt32LE(offset) !== 0x4550)
    throw new Error("Windows native addon PE header is invalid");
  if (data.readUInt16LE(offset + 4) !== (arch === "arm64" ? 0xaa64 : 0x8664))
    throw new Error(
      `Native addon architecture does not match ${arch}: ${path.basename(file)}`,
    );
}

/** A manifest records regular files only; no junction or symlink can refer back to the build machine. */
export async function inventory(directory, arch, forbiddenPaths = []) {
  const files = [];
  const pending = [];
  async function walk(root, relative = "") {
    for (const name of (await readdir(root)).sort()) {
      const file = path.join(root, name);
      const entry = relative ? `${relative}/${name}` : name;
      const info = await lstat(file);
      if (info.isSymbolicLink())
        throw new Error(`Bundle contains a link: ${entry}`);
      if (info.isDirectory()) await walk(file, entry);
      else if (info.isFile()) {
        if (entry === "bundle.json" || entry === ".incomplete") continue;
        pending.push({ file, entry, name, size: info.size });
      } else throw new Error(`Bundle contains a special file: ${entry}`);
    }
  }
  await walk(directory);
  const forbiddenForms = forbiddenPaths
    .flatMap((value) => [
      value,
      value.replaceAll("\\", "/"),
      value.replaceAll("\\", "\\\\"),
    ])
    .map((value) => value.toLowerCase());
  let index = 0;
  // Bound open handles while hashing independent files. Wait for all owners even if one fails.
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, async () => {
      while (index < pending.length) {
        const { file, entry, name, size } = pending[index++];
        if (name.endsWith(".node")) await assertAddonArchitecture(file, arch);
        const inspectText =
          forbiddenForms.length > 0 &&
          /\.(?:[cm]?js|json|cmd|bat|ps1|map|ya?ml|toml|py|pth|ini|cfg|sh)$/i.test(
            name,
          );
        const hash = createHash("sha256");
        if (size <= 4_194_304 || inspectText) {
          const bytes = await readFile(file);
          hash.update(bytes);
          if (inspectText) {
            const content = bytes.toString("utf8").toLowerCase();
            if (forbiddenForms.some((value) => content.includes(value)))
              throw new Error(`Bundle contains a build-machine path: ${entry}`);
          }
        } else
          for await (const chunk of createReadStream(file)) hash.update(chunk);
        files.push({ path: entry, size, sha256: hash.digest("hex") });
      }
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
