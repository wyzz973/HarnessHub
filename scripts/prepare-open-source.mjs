/** Derive an open-source engine payload from fixed, prepared local packages. Never installs or downloads. */
import {
  readFile,
  writeFile,
  mkdir,
  lstat,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  copyTree,
  distributableFile,
  materializeNodeModules,
  within,
} from "./lib/bundle-copy.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
export function selectOpenSource(metadata, edition) {
  if (
    metadata?.schemaVersion !== 1 ||
    metadata.platform !== "win32" ||
    !["arm64", "x64"].includes(metadata.arch) ||
    metadata.nodeVersion !== "24.20.0" ||
    !Array.isArray(metadata.engines) ||
    !Array.isArray(metadata.components)
  )
    throw new Error("Unsupported prepared metadata");
  if (
    edition?.schemaVersion !== 1 ||
    edition.id !== "open-source-chat-completions" ||
    !Array.isArray(edition.engines) ||
    edition.engines.length === 0 ||
    new Set(edition.engines).size !== edition.engines.length
  )
    throw new Error("Invalid open-source edition");
  const engines = edition.engines.map((id) => {
    const matches = metadata.engines.filter((engine) => engine.id === id);
    if (matches.length !== 1)
      throw new Error(`Open-source engine missing or duplicated: ${id}`);
    return matches[0];
  });
  const componentIds = new Set([
    ...edition.engines,
    ...edition.npmDependencies,
    ...edition.extraComponents,
  ]);
  return {
    ...metadata,
    edition: edition.id,
    engines,
    components: metadata.components.filter((item) => componentIds.has(item.id)),
  };
}
export async function prepareOpenSource(sourceArgument, outputArgument) {
  const source = await realpath(sourceArgument),
    output = path.resolve(outputArgument);
  if (
    within(source, output) ||
    within(output, source) ||
    !within(repo, source) ||
    !within(repo, output) ||
    !/^\.(tools|tmp)[\\/]/.test(path.relative(repo, output))
  )
    throw new Error(
      "Use separate prepared and output directories inside this checkout's .tools or .tmp",
    );
  const sourceInfo = await lstat(sourceArgument);
  if (sourceInfo.isSymbolicLink())
    throw new Error("Prepared root must not be a link");
  const metadata = JSON.parse(
    await readFile(path.join(source, "prepared.json"), "utf8"),
  );
  const edition = JSON.parse(
    await readFile(
      path.join(repo, "distribution/open-source-edition.json"),
      "utf8",
    ),
  );
  const selected = selectOpenSource(metadata, edition);
  if (
    process.platform !== metadata.platform ||
    process.arch !== metadata.arch ||
    process.versions.node !== metadata.nodeVersion
  )
    throw new Error("Use the matching native Windows Node 24.20.0 runtime");
  await mkdir(path.dirname(output), { recursive: true });
  if (!within(await realpath(repo), await realpath(path.dirname(output))))
    throw new Error("Output parent escapes this checkout");
  await mkdir(output);
  await writeFile(
    path.join(output, ".incomplete"),
    "Preparation in progress\n",
    { flag: "wx" },
  );
  const options = {
    allowedRoots: [source],
    filter: (relative, name) =>
      distributableFile(relative, name, metadata.arch),
  };
  for (const name of ["runtime", "bin", "tools"])
    await copyTree(path.join(source, name), path.join(output, name), options);
  for (const name of edition.nativeDirectories)
    await copyTree(
      path.join(source, "engines", name),
      path.join(output, "engines", name),
      options,
    );
  const sourceNpm = path.join(source, "engines/npm");
  const npmManifest = JSON.parse(
    await readFile(path.join(sourceNpm, "package.json"), "utf8"),
  );
  const npmOutput = path.join(output, "engines/npm");
  const graph = await materializeNodeModules(
    sourceNpm,
    path.join(npmOutput, "node_modules"),
    { arch: metadata.arch, dependencies: edition.npmDependencies },
  );
  await writeFile(
    path.join(npmOutput, "package.json"),
    JSON.stringify(
      {
        name: "harnesshub-open-source-engines",
        version: "1.0.0",
        private: true,
        dependencies: Object.fromEntries(
          edition.npmDependencies.map((name) => [
            name,
            npmManifest.dependencies[name],
          ]),
        ),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  for (const engine of selected.engines)
    for (const relative of engine.requiredFiles ?? []) {
      if (relative.startsWith("scripts/")) continue; // These are copied from this checkout by package-bundle.
      const target = path.resolve(output, relative);
      if (!within(output, target) || !(await lstat(target)).isFile())
        throw new Error(`Required engine file missing: ${engine.id}`);
    }
  selected.components = [...selected.components, ...graph];
  await writeFile(
    path.join(output, "prepared.json"),
    JSON.stringify(selected, null, 2) + "\n",
    { flag: "wx" },
  );
  await unlink(path.join(output, ".incomplete"));
  return {
    output,
    engines: selected.engines.map((engine) => engine.id),
    npmComponents: graph.length,
    downloads: false,
    modelCalled: false,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: { prepared: { type: "string" }, output: { type: "string" } },
      strict: true,
    });
    if (!values.prepared || !values.output)
      throw new Error(
        "Usage: node scripts/prepare-open-source.mjs --prepared FIXED_PREPARED --output NEW_DIRECTORY",
      );
    console.log(
      JSON.stringify(await prepareOpenSource(values.prepared, values.output)),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
