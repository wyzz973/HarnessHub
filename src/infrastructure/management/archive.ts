import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { x as extractTar } from "tar";
import { open as openZip, type ZipFile, type Entry } from "yauzl";
import unbzip2 from "unbzip2-stream";
import { ManagementError, type ManagementInstallContext } from "../../contracts/management.js";

export function insideManagement(root: string, target: string): boolean { const path = relative(root, target); return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path); }
function archivePath(root: string, value: string): string {
  if (!value || value.length > 4096 || /[\0\r\n\\]/u.test(value) || isAbsolute(value) || /^[A-Za-z]:/u.test(value)) throw new ManagementError("UNSAFE_ARCHIVE", "archive entry path is invalid");
  const target = resolve(root, value); if (!insideManagement(root, target)) throw new ManagementError("UNSAFE_ARCHIVE", "archive entry escapes its managed slot"); return target;
}
export async function unpackManagementArchive(archive: string, destination: string, url: string, context: ManagementInstallContext): Promise<void> {
  context.assertOwned(); await mkdir(destination, { mode: 0o700, recursive: true }); context.assertOwned();
  const root = await realpath(destination); context.assertOwned(); let entries = 0, total = 0;
  const inspect = (path: string, size: number, link?: string, hard = false): void => {
    context.assertOwned(); archivePath(root, path);
    if (++entries > 100000 || !Number.isSafeInteger(size) || size < 0 || (total += size) > 1024 * 1024 * 1024) throw new ManagementError("ARCHIVE_LIMIT", "archive exceeds its entry or unpacked byte budget");
    if (link !== undefined) {
      if (isAbsolute(link) || /[\0\r\n\\]/u.test(link)) throw new ManagementError("UNSAFE_ARCHIVE", "archive link is invalid");
      const target = resolve(hard ? root : dirname(archivePath(root, path)), link);
      if (!insideManagement(root, target)) throw new ManagementError("UNSAFE_ARCHIVE", "archive link escapes its managed slot");
    }
  };
  if (new URL(url).pathname.endsWith(".zip")) {
    const zip = await new Promise<ZipFile>((resolveZip, reject) => openZip(archive, { lazyEntries: true, autoClose: true, validateEntrySizes: true, strictFileNames: true }, (error, opened) => error || !opened ? reject(error ?? new Error("missing zip")) : resolveZip(opened)));
    const closed = new Promise<void>(resolveClosed => zip.once("close", resolveClosed));
    context.assertOwned(); const links: { path: string; target: string }[] = [];
    try { await new Promise<void>((resolveZip, reject) => {
      let failed = false;
      const fail = (error: unknown): void => { if (failed) return; failed = true; zip.close(); reject(error); };
      const abort = (): void => fail(new ManagementError("CANCELLED", "archive extraction was cancelled"));
      context.signal.addEventListener("abort", abort, { once: true });
      zip.once("error", fail); zip.once("end", () => { context.signal.removeEventListener("abort", abort); resolveZip(); });
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          const path = archivePath(root, entry.fileName), mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          inspect(entry.fileName, entry.uncompressedSize);
          if (entry.fileName.endsWith("/")) { await mkdir(path, { recursive: true, mode: 0o700 }); context.assertOwned(); zip.readEntry(); return; }
          await mkdir(dirname(path), { recursive: true, mode: 0o700 }); context.assertOwned();
          const stream = await new Promise<import("node:stream").Readable>((res, rej) => zip.openReadStream(entry, (error, value) => error || !value ? rej(error ?? new Error("missing stream")) : res(value)));
          try { context.assertOwned(); } catch (error) { stream.destroy(); throw error; }
          if ((mode & 0o170000) === 0o120000) {
            if (entry.uncompressedSize > 4096) throw new ManagementError("UNSAFE_ARCHIVE", "archive link is too large");
            const chunks: Buffer[] = []; let bytes = 0; for await (const raw of stream) { context.assertOwned(); if (!Buffer.isBuffer(raw)) throw new ManagementError("INVALID_ARCHIVE", "archive link is not bytes"); bytes += raw.length;
              if (bytes > 4096) throw new ManagementError("UNSAFE_ARCHIVE", "archive link grew beyond its byte budget"); chunks.push(raw); }
            const target = Buffer.concat(chunks).toString("utf8"); inspect(entry.fileName, 0, target); links.push({ path, target });
          } else if ((mode & 0o170000) !== 0 && (mode & 0o170000) !== 0o100000) throw new ManagementError("UNSAFE_ARCHIVE", "archive contains a non-regular entry");
          else { await pipeline(stream, createWriteStream(path, { flags: "wx", mode: mode & 0o111 ? 0o755 : 0o644 }), { signal: context.signal }); context.assertOwned(); }
          zip.readEntry();
        })().catch(fail);
      }); zip.readEntry();
    }); } finally { zip.close(); await closed; }
    for (const link of links) { context.assertOwned(); await symlink(link.target, link.path); context.assertOwned(); }
  } else {
    let policyError: unknown = null;
    const extraction = extractTar({ cwd: root, strict: true, preservePaths: false, noChmod: false,
      filter: (path, entry) => {
        if (policyError !== null) return false;
        try {
          if (!("type" in entry)) throw new ManagementError("INVALID_ARCHIVE", "archive entry metadata is unavailable");
          inspect(path, entry.size ?? 0, entry.type === "SymbolicLink" || entry.type === "Link" ? entry.linkpath : undefined, entry.type === "Link");
          if (!["File", "OldFile", "Directory", "SymbolicLink", "Link", "ExtendedHeader", "GlobalExtendedHeader"].includes(entry.type)) throw new ManagementError("UNSAFE_ARCHIVE", "archive contains an unsupported entry"); return true;
        } catch (error) { policyError = error; queueMicrotask(() => extraction.emit("error", error)); return false; }
      } });
    if (new URL(url).pathname.endsWith(".bz2")) await pipeline(createReadStream(archive), unbzip2(), extraction, { signal: context.signal });
    else await pipeline(createReadStream(archive), extraction, { signal: context.signal }); context.assertOwned();
    if (policyError !== null) throw policyError;
  }
  // Resolve the complete tree after extraction: internal links are permitted; escaping links are not.
  for (const link of [root]) if (!insideManagement(root, await realpath(link))) throw new ManagementError("UNSAFE_ARCHIVE", "archive root changed");
}
