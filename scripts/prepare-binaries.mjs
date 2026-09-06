import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, lstat, readdir, rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: { arch: { type: "string", default: process.arch }, root: { type: "string" } } });
if (process.platform !== "win32" || !["arm64", "x64"].includes(values.arch)) throw new Error("Native Windows arm64/x64 preparation required");
const target = path.resolve(values.root ?? path.join(repo, ".tools", "contest-prepared", `win32-${values.arch}`));
const sources = JSON.parse(await readFile(path.join(repo, "distribution/binary-sources.json"), "utf8"));
const cache = path.join(repo, ".tmp", "contest-downloads");
await mkdir(cache, { recursive: true });
const receipts = [];
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function noLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || (await lstat(file)).isSymbolicLink()) throw new Error(`Archive link is unsupported: ${file}`);
    if (entry.isDirectory()) await noLinks(file);
  }
}
await Promise.all(sources.map(async (source) => {
  const binary = source.targets[values.arch];
  if (!binary || !/^https:\/\//.test(binary.archive)) throw new Error(`Missing pinned archive for ${source.id}`);
  const archive = path.join(cache, `${source.id}-${source.version}-${values.arch}.zip`);
  try { await lstat(archive); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.log(`Downloading ${source.id} ${source.version} ${values.arch}`);
    const response = await fetch(binary.archive, { signal: AbortSignal.timeout(600000) });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${source.id}`);
    const partial = archive + "." + randomUUID() + ".partial";
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: "wx" }));
      if (binary.sha256 && await digest(partial) !== binary.sha256) throw new Error(`Official archive hash mismatch: ${source.id}`);
      await rename(partial, archive);
    } finally { await rm(partial, { force: true }); }
  }
  const sha256 = await digest(archive);
  if (binary.sha256 && sha256 !== binary.sha256) throw new Error(`Official archive hash mismatch: ${source.id}`);
  const destination = path.join(target, "engines", source.id);
  await mkdir(destination, { recursive: true });
  const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  const listing = spawnSync(tar, ["-tf", archive], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (listing.error || listing.status !== 0) throw new Error(`Cannot inspect archive: ${source.id}`);
  for (const entry of listing.stdout.split(/\r?\n/).filter(Boolean)) {
    const normalized = entry.replaceAll("\\", "/").replace(/^\.\//, "");
    if (path.win32.isAbsolute(normalized) || normalized.includes(":") || normalized.split("/").includes("..")) throw new Error(`Unsafe archive entry: ${source.id}`);
  }
  const extracted = spawnSync(tar, ["-xf", archive, "-C", destination], { stdio: "inherit", windowsHide: true, timeout: 180000 });
  if (extracted.error || extracted.status !== 0) throw new Error(`Cannot extract archive: ${source.id}`);
  await noLinks(destination);
  let relative = binary.cmd.replaceAll("\\", "/").replace(/^\.\//, "");
  let executable = path.join(destination, relative);
  try { await lstat(executable); } catch (error) {
    if (error.code !== "ENOENT" || path.extname(executable)) throw error;
    executable += ".exe"; relative += ".exe";
    await lstat(executable);
  }
  receipts.push({ id: source.id, name: source.name, version: source.version, license: source.license, source: binary.archive, sha256, upstreamHash: Boolean(binary.sha256), command: [`\${bundle}/engines/${source.id}/${relative}`, ...(binary.args ?? [])] });
  console.log(`Prepared ${source.id}: ${relative}`);
}));
await writeFile(path.join(target, "binary-receipts.json"), JSON.stringify(receipts.sort((a, b) => a.id.localeCompare(b.id)), null, 2) + "\n");
