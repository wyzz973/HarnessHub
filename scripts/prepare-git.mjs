/** Build-time preparation only; judge startup never invokes this downloader. */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  lstat,
  rename,
  rm,
  writeFile,
  readdir,
  copyFile,
} from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import path from "node:path";
const repo = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: {
    arch: { type: "string", default: process.arch },
    root: { type: "string" },
  },
});
if (process.platform !== "win32" || !["arm64", "x64"].includes(values.arch))
  throw new Error("Windows ARM64/x64 required");
const root = path.resolve(
  values.root ??
    path.join(repo, ".tools/contest-prepared", `win32-${values.arch}`),
);
const cache = path.join(repo, ".tmp/contest-downloads");
await mkdir(cache, { recursive: true });
async function digest(file) {
  const hash = createHash("sha256");
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest("hex");
}
async function download(url, name, expected) {
  const target = path.join(cache, name);
  try {
    await lstat(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const partial = target + "." + randomUUID() + ".partial";
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(600000),
      });
      if (!response.ok || !response.body)
        throw new Error(`Download failed: ${name}`);
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(partial, { flags: "wx" }),
      );
      if ((await digest(partial)) !== expected)
        throw new Error(`Archive hash mismatch: ${name}`);
      await rename(partial, target);
    } finally {
      await rm(partial, { force: true });
    }
  }
  if ((await digest(target)) !== expected)
    throw new Error(`Cached archive hash mismatch: ${name}`);
  return target;
}
const arch = values.arch === "x64" ? "64-bit" : "arm64";
const name = `PortableGit-2.55.0.5-${arch}.7z.exe`;
const source = `https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/${name}`;
const sha256 =
  values.arch === "arm64"
    ? "49d1dd3158017fa9805d07268433dbab7021b2ec1c1cc3fbabaf8b8255764dd0"
    : "5aa8a20f6e9abb2c755f0e73c91c687701a46b309ad84a0ca6509380fa4ae290";
const archive = await download(source, name, sha256);
const extractor = await download(
  "https://www.7-zip.org/a/7zr.exe",
  "7zr.exe",
  "ad4c82fadcbdf93c03b4fc440f300509c7d60c5c2f4d183e35d9d70d6957037d",
);
const tar = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32/tar.exe",
);
const listing = spawnSync(tar, ["-tf", archive], {
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 8 * 1024 * 1024,
});
if (listing.status !== 0 || listing.error)
  throw new Error("Cannot inspect PortableGit archive");
for (const entry of listing.stdout.split(/\r?\n/).filter(Boolean)) {
  const normalized = entry.replaceAll("\\", "/");
  if (
    path.win32.isAbsolute(normalized) ||
    normalized.includes(":") ||
    normalized.split("/").includes("..")
  )
    throw new Error("Unsafe Git archive path");
}
const destination = path.join(root, "bin/git");
await mkdir(destination, { recursive: true });
const staging = path.join(cache, `git-expanded-${values.arch}-${randomUUID()}`);
await mkdir(staging);
const extraction = spawnSync(extractor, ["x", "-y", `-o${staging}`, archive], {
  encoding: "utf8",
  windowsHide: true,
  timeout: 180000,
  maxBuffer: 8 * 1024 * 1024,
});
if (extraction.status !== 0 || extraction.error)
  throw new Error("Cannot extract PortableGit");
async function transfer(source, target) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name),
      to = path.join(target, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("Git archive links are unsupported");
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await transfer(from, to);
    } else if (entry.isFile()) {
      try {
        const existing = await lstat(to);
        if (
          !existing.isFile() ||
          existing.isSymbolicLink() ||
          (await digest(from)) !== (await digest(to))
        )
          throw new Error(
            "Existing Git payload differs; prepare into a fresh root",
          );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await copyFile(from, to, 1);
      }
    } else throw new Error("Unsupported Git archive entry");
  }
}
await transfer(staging, destination);
const check = spawnSync(path.join(destination, "cmd/git.exe"), ["--version"], {
  encoding: "utf8",
  windowsHide: true,
  timeout: 10000,
});
if (check.status !== 0 || !check.stdout.includes("2.55.0.windows.5"))
  throw new Error("PortableGit verification failed");
await writeFile(
  path.join(root, "git-receipt.json"),
  JSON.stringify(
    {
      version: "2.55.0.windows.5",
      source,
      sha256,
      license: "GPL-2.0 and bundled component licenses",
    },
    null,
    2,
  ) + "\n",
);
console.log(`Prepared PortableGit ${values.arch}`);
