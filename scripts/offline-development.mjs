/** Attach already-packaged dependencies and build a company checkout without package managers or network access. */
import { lstat, readFile, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { copyTree, within } from "./lib/bundle-copy.mjs";

const bundle = fileURLToPath(new URL("../", import.meta.url));
async function absent(target) {
  try {
    await lstat(target);
    throw new Error(
      `Target already exists; inspect and preserve the existing dependency directory: ${target}`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
async function compatible(workspace) {
  for (const [label, directory] of [
    ["root", workspace],
    ["web", path.join(workspace, "web")],
  ]) {
    const actual = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    );
    const available = JSON.parse(
      await readFile(
        path.join(bundle, "development", `${label}.package.json`),
        "utf8",
      ),
    );
    if (actual.name !== available.name)
      throw new Error(`Not the matching HarnessHub ${label} workspace`);
    if (!isDeepStrictEqual(actual.pnpm ?? {}, available.pnpm ?? {}))
      throw new Error(
        "Offline kit package-manager overrides/patch settings differ; prepare an updated kit",
      );
    for (const group of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ]) {
      for (const [name, version] of Object.entries(actual[group] ?? {}))
        if (available[group]?.[name] !== version)
          throw new Error(
            `Offline kit does not contain the requested ${label} dependency ${name}@${version}; prepare an updated kit outside the company network`,
          );
    }
    if (label === "root") {
      const canonical = async (file) =>
        (await readFile(file, "utf8")).replaceAll("\r\n", "\n");
      if (
        (await canonical(path.join(workspace, "pnpm-lock.yaml"))) !==
        (await canonical(path.join(bundle, "development/pnpm-lock.yaml")))
      )
        throw new Error(
          "Offline kit lockfile differs; prepare an updated kit outside the company network",
        );
      for (const relative of Object.values(
        available.pnpm?.patchedDependencies ?? {},
      )) {
        if (
          typeof relative !== "string" ||
          !/^patches\/[a-zA-Z0-9@._+-]+\.patch$/.test(relative)
        )
          throw new Error("Unsupported offline dependency patch path");
        if (
          (await canonical(path.join(workspace, relative))) !==
          (await canonical(path.join(bundle, relative)))
        )
          throw new Error(
            "Offline kit dependency patch differs; prepare an updated kit",
          );
      }
    }
  }
}
async function execute(args, cwd) {
  const child = spawn(process.execPath, args, {
    cwd,
    windowsHide: true,
    env: {
      ...process.env,
      COREPACK_ENABLE_NETWORK: "0",
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_OPTIONS: "",
      NODE_PATH: "",
    },
    stdio: "inherit",
  });
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`Offline build step failed (${code})`);
}
export async function offlineDevelopment(command, workspaceArgument) {
  if (
    !["prepare", "build", "typecheck"].includes(command) ||
    !workspaceArgument ||
    !path.isAbsolute(workspaceArgument)
  )
    throw new Error(
      "Usage: Dev.cmd prepare|build|typecheck ABSOLUTE_COMPANY_CHECKOUT",
    );
  const workspace = await realpath(path.resolve(workspaceArgument));
  if (!within(workspace, await realpath(path.join(workspace, "web"))))
    throw new Error("Company web workspace resolves outside the checkout");
  await compatible(workspace);
  if (command === "prepare") {
    const destinations = [
      path.join(workspace, "node_modules"),
      path.join(workspace, "web/node_modules"),
    ];
    for (const target of destinations) await absent(target);
    const { readBundle, verifyBundle } =
      await import("../dist/src/distribution/manifest.js");
    await verifyBundle(bundle, await readBundle(bundle), true);
    for (const [index, label] of ["root", "web"].entries())
      await copyTree(
        path.join(bundle, "development", label, "node_modules"),
        destinations[index],
      );
    return {
      prepared: true,
      workspace,
      downloads: false,
      sourceFilesChanged: false,
    };
  }
  const compiler = path.join(workspace, "node_modules/typescript/bin/tsc");
  await execute(
    [
      compiler,
      "-p",
      "tsconfig.json",
      ...(command === "typecheck" ? ["--noEmit"] : []),
    ],
    workspace,
  );
  if (command === "typecheck")
    return { typechecked: true, scope: "gateway-and-tests", downloads: false };
  for (const script of [
    "build-keychain.mjs",
    "build-windows-job.mjs",
    "build-windows-acl.mjs",
  ])
    await execute([path.join(workspace, "scripts", script)], workspace);
  await execute(
    [path.join(workspace, "web/node_modules/next/dist/bin/next"), "build"],
    path.join(workspace, "web"),
  );
  return { built: true, workspace, downloads: false };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 4)
      throw new Error(
        "Usage: Dev.cmd prepare|build|typecheck ABSOLUTE_COMPANY_CHECKOUT",
      );
    console.log(
      JSON.stringify(
        await offlineDevelopment(process.argv[2], process.argv[3]),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
