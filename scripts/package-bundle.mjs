import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  copyTree,
  distributableFile,
  inventory,
  materializeNodeModules,
  relocateStandalone,
  within,
} from "./lib/bundle-copy.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));

async function verifyConsole(output, server, env) {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const helper = path.join(output, "dist", "native", "harnesshub-job.exe"),
    token = randomUUID();
  const ready = Promise.withResolvers(),
    closed = Promise.withResolvers();
  const child = spawn(
    helper,
    [
      "run",
      String(process.pid),
      token,
      path.join(output, "runtime", "node.exe"),
      server,
    ],
    {
      cwd: path.dirname(output),
      env: {
        ...env,
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
        NEXT_TELEMETRY_DISABLED: "1",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  const timeout = setTimeout(
    () => ready.reject(new Error("Bundled console did not become ready")),
    30_000,
  );
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout = (stdout + chunk).slice(-16384);
    if (/Ready in/.test(stdout)) ready.resolve();
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16384);
  });
  child.once("error", ready.reject);
  child.once("close", (code) => {
    closed.resolve();
    ready.reject(
      new Error(`Bundled console exited (${code}): ${stderr.slice(-2000)}`),
    );
  });
  try {
    await ready.promise;
    const origin = `http://127.0.0.1:${port}`;
    const response = await fetch(origin, {
      signal: AbortSignal.timeout(10_000),
    });
    const html = await response.text();
    if (response.status !== 200 || !html.includes("HarnessHub"))
      throw new Error("Bundled console page verification failed");
    const asset = /src="([^\"]+_next\/static[^\"]+\.js)"/.exec(html)?.[1];
    if (!asset) throw new Error("Bundled console has no static script");
    const resource = await fetch(new URL(asset, origin), {
      signal: AbortSignal.timeout(10_000),
    });
    await resource.arrayBuffer();
    if (resource.status !== 200)
      throw new Error("Bundled console static script verification failed");
  } finally {
    clearTimeout(timeout);
    try {
      await execute(helper, ["close", token, "5000"]);
    } finally {
      child.kill("SIGKILL");
      await closed.promise;
    }
  }
}

function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 262_144) child.kill("SIGKILL");
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 262_144) child.kill("SIGKILL");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(
            `Bundle verification command failed (${code}): ${stderr.slice(0, 2000)}`,
          ),
        );
    });
  });
}

/** Build only a new directory; all application inputs are explicit production allowlists. */
export async function packageBundle(preparedDirectory, outputDirectory) {
  const prepared = await realpath(preparedDirectory);
  const output = path.resolve(outputDirectory);
  if (within(prepared, output))
    throw new Error("Bundle output must be outside the prepared input");
  const metadata = JSON.parse(
    await readFile(path.join(prepared, "prepared.json"), "utf8"),
  );
  const forbiddenPaths = [
    repository.replace(/[\\/]$/, ""),
    prepared,
    homedir(),
  ];
  const serializedMetadata = JSON.stringify(metadata).toLowerCase();
  for (const value of forbiddenPaths) {
    if (
      [value, value.replaceAll("\\", "/"), value.replaceAll("\\", "\\\\")].some(
        (form) => serializedMetadata.includes(form.toLowerCase()),
      )
    )
      throw new Error(
        "Prepared metadata contains a build-machine path; use bundle/state placeholders",
      );
  }
  if (
    metadata.schemaVersion !== 1 ||
    metadata.platform !== "win32" ||
    !["arm64", "x64"].includes(metadata.arch) ||
    metadata.nodeVersion !== "24.20.0" ||
    !Array.isArray(metadata.engines) ||
    !Array.isArray(metadata.components)
  )
    throw new Error(
      "Prepared bundle metadata is invalid or uses an unsupported runtime",
    );
  if (process.platform !== metadata.platform || process.arch !== metadata.arch)
    throw new Error(
      "Build this bundle with a Node runtime matching its Windows target architecture",
    );
  const node = path.join(prepared, "runtime", "node.exe");
  const runtime = JSON.parse(
    await execute(node, [
      "-p",
      "JSON.stringify({version:process.versions.node,arch:process.arch,platform:process.platform})",
    ]),
  );
  if (
    runtime.version !== metadata.nodeVersion ||
    runtime.arch !== metadata.arch ||
    runtime.platform !== metadata.platform
  )
    throw new Error("Prepared Node runtime does not match its metadata");
  if (
    !(
      await lstat(path.join(repository, "dist", "src", "release-main.js"))
    ).isFile()
  )
    throw new Error("Build the release entry before packaging");
  await mkdir(output); // EEXIST is deliberate; no supplied target is overwritten or removed.
  await writeFile(
    path.join(output, ".incomplete"),
    "Bundle construction is in progress. Do not distribute.\n",
    { flag: "wx" },
  );
  const app = JSON.parse(
    await readFile(path.join(repository, "package.json"), "utf8"),
  );
  await writeFile(
    path.join(output, "package.json"),
    JSON.stringify(
      { name: app.name, version: app.version, type: "module", private: true },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await copyTree(
    path.join(repository, "dist", "src"),
    path.join(output, "dist", "src"),
    {
      filter: (relative, name) =>
        !path.extname(name) || name.endsWith(".js") || name.endsWith(".json"),
    },
  );
  for (const name of [
    "harnesshub-job.exe",
    "harnesshub-acl.exe",
    "harnesshub-secrets.exe",
  ])
    await copyTree(
      path.join(repository, "dist", "native", name),
      path.join(output, "dist", "native", name),
    );
  for (const name of (await readdir(path.join(repository, "scripts"))).filter(
    (entry) =>
      /^launch-[a-z-]+\.mjs$/.test(entry) || entry === "spawn-engine.mjs",
  ))
    await copyTree(
      path.join(repository, "scripts", name),
      path.join(output, "scripts", name),
    );
  const dependencies = await materializeNodeModules(
    repository,
    path.join(output, "node_modules"),
    { arch: metadata.arch },
  );
  const developmentComponents = [];
  if (metadata.edition === "open-source-chat-completions") {
    for (const [label, directory] of [
      ["root", repository],
      ["web", path.join(repository, "web")],
    ]) {
      const modules = await materializeNodeModules(
        directory,
        path.join(output, "development", label, "node_modules"),
        {
          arch: metadata.arch,
          includeDevelopment: true,
          allowedRoot: path.join(repository, "node_modules"),
        },
      );
      developmentComponents.push(...modules);
      await copyTree(
        path.join(directory, "package.json"),
        path.join(output, "development", `${label}.package.json`),
      );
    }
    await copyTree(
      path.join(repository, "pnpm-lock.yaml"),
      path.join(output, "development", "pnpm-lock.yaml"),
    );
    await copyTree(
      path.join(repository, "scripts/offline-development.mjs"),
      path.join(output, "scripts/offline-development.mjs"),
    );
    await copyTree(
      path.join(repository, "scripts/lib/bundle-copy.mjs"),
      path.join(output, "scripts/lib/bundle-copy.mjs"),
    );
    await copyTree(
      path.join(repository, "vendor/engine-sources"),
      path.join(output, "vendor/engine-sources"),
    );
    await copyTree(
      path.join(repository, "distribution/source-repositories.json"),
      path.join(output, "distribution/source-repositories.json"),
    );
    await copyTree(
      path.join(repository, "skills"),
      path.join(output, "skills"),
    );
    await writeFile(
      path.join(output, "Dev.cmd"),
      '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\offline-development.mjs" %*\r\nexit /b %errorlevel%\r\n',
      { flag: "wx" },
    );
  }
  const nativeMcp = path.join(repository, "scripts/native-mcp");
  try {
    await lstat(nativeMcp);
    await copyTree(nativeMcp, path.join(output, "scripts/native-mcp"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const name of ["runtime", "engines", "bin", "tools"]) {
    const source = path.join(prepared, name);
    try {
      await lstat(source);
    } catch (error) {
      if (name !== "runtime" && error.code === "ENOENT") continue;
      throw error;
    }
    await copyTree(source, path.join(output, name), {
      allowedRoots: [prepared],
      filter: (relative, entry) =>
        distributableFile(relative, entry, metadata.arch),
    });
  }
  const standalone = path.join(repository, "web", ".next", "standalone");
  await copyTree(standalone, path.join(output, "console"), {
    allowedRoots: [standalone, path.join(repository, "node_modules")],
    filter: (relative, name) =>
      name !== "node_modules" &&
      distributableFile(relative, name, metadata.arch),
  });
  let consoleRelative;
  for (const relative of ["web/server.js", "server.js"]) {
    try {
      if ((await lstat(path.join(output, "console", relative))).isFile()) {
        consoleRelative = relative;
        break;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!consoleRelative)
    throw new Error(
      "Next standalone server.js was not found; build the console with standalone output",
    );
  const consoleApp = path.dirname(
    path.join(output, "console", consoleRelative),
  );
  await relocateStandalone(
    path.join(output, "console", consoleRelative),
    path.join(output, "console"),
  );
  const consoleDependencies = await materializeNodeModules(
    path.join(repository, "web"),
    path.join(consoleApp, "node_modules"),
    { allowedRoot: path.join(repository, "node_modules"), arch: metadata.arch },
  );
  await copyTree(
    path.join(repository, "web", ".next", "static"),
    path.join(consoleApp, ".next", "static"),
  );
  try {
    await lstat(path.join(repository, "web", "public"));
    await copyTree(
      path.join(repository, "web", "public"),
      path.join(consoleApp, "public"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(
    path.join(output, "hub.cmd"),
    '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0dist\\src\\release-main.js" %*\r\nexit /b %errorlevel%\r\n',
    { flag: "wx" },
  );
  await copyTree(
    path.join(
      repository,
      metadata.edition === "open-source-chat-completions"
        ? "distribution/README-open-source.txt"
        : "distribution/README.txt",
    ),
    path.join(output, "README.txt"),
  );
  await copyTree(
    path.join(
      repository,
      metadata.edition === "open-source-chat-completions"
        ? "distribution/deepseek-open-source.json"
        : "distribution/deepseek.json",
    ),
    path.join(output, "examples/deepseek.json"),
  );
  if (metadata.edition === "open-source-chat-completions") {
    await copyTree(
      path.join(repository, "distribution/company-chat.json"),
      path.join(output, "examples/company-chat.json"),
    );
  }
  await copyTree(
    path.join(repository, "distribution/THIRD_PARTY_NOTICES.md"),
    path.join(output, "THIRD_PARTY_NOTICES.md"),
  );
  await copyTree(
    path.join(repository, "web/licenses"),
    path.join(output, "web/licenses"),
  );
  await copyTree(
    path.join(repository, "patches"),
    path.join(output, "patches"),
  );
  await writeFile(
    path.join(output, "Start.cmd"),
    '@echo off\r\ncall "%~dp0hub.cmd" start %*\r\nexit /b %errorlevel%\r\n',
    { flag: "wx" },
  );
  // The import resolves exclusively from the relocated package; no source, pnpm,
  // NODE_PATH, or user-installed Node can satisfy a missing runtime dependency.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(?:SystemRoot|WINDIR|COMSPEC|TEMP|TMP)$/i.test(name),
    ),
  );
  env.PATH = `${path.join(output, "runtime")};${path.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32")}`;
  await execute(
    path.join(output, "runtime", "node.exe"),
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(path.join(output, "dist", "src", "main.js")).href)});console.log('bundle-import-ok')`,
    ],
    { cwd: path.dirname(output), env },
  );
  await verifyConsole(
    output,
    path.join(output, "console", consoleRelative),
    env,
  );
  const files = await inventory(output, metadata.arch, forbiddenPaths);
  const bundle = {
    schemaVersion: 1,
    platform: metadata.platform,
    arch: metadata.arch,
    nodeVersion: metadata.nodeVersion,
    engines: metadata.engines,
    components: [
      ...metadata.components,
      ...dependencies,
      ...consoleDependencies,
      ...developmentComponents,
    ],
    consoleEntry: `console/${consoleRelative.replaceAll("\\", "/")}`,
    files,
  };
  await writeFile(
    path.join(output, "bundle.json"),
    JSON.stringify(bundle, null, 2) + "\n",
    { flag: "wx" },
  );
  const { unlink } = await import("node:fs/promises");
  await unlink(path.join(output, ".incomplete"));
  return { output, files: files.length, consoleEntry: bundle.consoleEntry };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: { prepared: { type: "string" }, output: { type: "string" } },
      allowPositionals: false,
    });
    if (!values.prepared || !values.output)
      throw new Error(
        "Usage: node scripts/package-bundle.mjs --prepared DIRECTORY --output NEW_DIRECTORY",
      );
    console.log(
      JSON.stringify(await packageBundle(values.prepared, values.output)),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
