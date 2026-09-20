import { lstat, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createZip, type ZipEntry } from "./logging/zip.js";
import { createRedactor } from "./worker/diagnostics.js";

/** HarnessHub's own diagnostic logs, copied whole (they rotate at 16 MiB). */
const HARNESS_LOG =
  /(^|\/)(logs\/gateway\.log(\.\d+)?|diagnostics\/(engine\.log(\.\d+)?|worker-errors\.log))$/;
const HARNESS_LIMIT = 32 * 1024 * 1024;
const NATIVE_FILES = 300;
const WALK_ENTRIES = 200_000;

export interface CollectedFile {
  path: string;
  kind: "harnesshub" | "engine";
  bytes: number;
  /** Bytes dropped from the start of the file (engine logs keep their tail). */
  truncated: number;
}

/**
 * Package every HarnessHub diagnostic log under `root` (Gateway log, Session
 * engine logs, Worker error logs, all rotated generations) plus the last
 * `nativeBytes` of each other `*.log` file (engine-native logs, at most 300)
 * into one ZIP with a `manifest.json`. Every file is redacted with the
 * credential patterns and the values of credential-like variables in `env`.
 * Symbolic links are not followed. Throws when `root` is missing or nothing
 * could be written; unreadable individual files are listed as skipped.
 */
export async function collectLogs(options: {
  root: string;
  out: string;
  nativeBytes?: number;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<{ out: string; files: CollectedFile[]; skipped: string[] }> {
  const root = path.resolve(options.root);
  if (!(await stat(root)).isDirectory())
    throw new Error(`Log root is not a directory: ${root}`);
  const nativeBytes = options.nativeBytes ?? 2 * 1024 * 1024;
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(options.env ?? process.env))
    if (
      value &&
      value.length >= 8 &&
      /(API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(name)
    )
      secrets.add(value);
  const redact = createRedactor(secrets);
  const files: CollectedFile[] = [];
  const skipped: string[] = [];
  const entries: ZipEntry[] = [];
  let seen = 0;
  let natives = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 12 || seen > WALK_ENTRIES) return;
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      skipped.push(path.relative(root, directory) || ".");
      return;
    }
    for (const child of children) {
      if (++seen > WALK_ENTRIES) return;
      const file = path.join(directory, child.name);
      if (child.isDirectory()) {
        await walk(file, depth + 1);
        continue;
      }
      if (!child.isFile()) continue;
      const relative = path.relative(root, file).split(path.sep).join("/");
      const own = HARNESS_LOG.test(relative);
      if (!own && !/\.log$/i.test(child.name)) continue;
      if (!own && natives >= NATIVE_FILES) {
        skipped.push(relative);
        continue;
      }
      try {
        const info = await lstat(file);
        if (!info.isFile()) continue;
        const limit = own ? HARNESS_LIMIT : nativeBytes;
        const bytes = await readFile(file);
        let kept = bytes.subarray(Math.max(0, bytes.length - limit));
        // A cut tail starts at the next full line, so no partial secret
        // escapes known-value redaction at the boundary.
        if (kept.length < bytes.length) {
          const newline = kept.indexOf(0x0a);
          if (newline >= 0) kept = kept.subarray(newline + 1);
        }
        const text = redact(kept.toString("utf8"));
        const data = Buffer.from(text, "utf8");
        entries.push({
          name: `${own ? "harnesshub" : "engines"}/${relative}`,
          data,
          modified: info.mtime,
        });
        files.push({
          path: relative,
          kind: own ? "harnesshub" : "engine",
          bytes: data.length,
          truncated: bytes.length - kept.length,
        });
        if (!own) natives++;
      } catch {
        skipped.push(relative);
      }
    }
  };
  await walk(root, 0);
  const now = options.now ?? new Date();
  entries.push({
    name: "manifest.json",
    data: Buffer.from(
      `${JSON.stringify(
        {
          createdAt: now.toISOString(),
          root,
          platform: `${process.platform}/${process.arch}`,
          node: process.version,
          redaction:
            "credential patterns plus values of *_API_KEY/*_TOKEN/*_SECRET/*_PASSWORD variables of the collecting process",
          files,
          skipped,
        },
        null,
        2,
      )}\n`,
    ),
    modified: now,
  });
  const out = path.resolve(options.out);
  await writeFile(out, createZip(entries), { mode: 0o600 });
  return { out, files, skipped };
}

function timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        root: { type: "string" },
        out: { type: "string" },
        "native-bytes": { type: "string" },
        help: { type: "boolean", default: false },
      },
    });
    if (values.help) {
      console.log(
        "Collect-Logs: node dist/src/collect-logs-main.js [--root <state or data dir>] [--out logs.zip] [--native-bytes 2097152]",
      );
    } else {
      // Bundle layout: <root>/dist/src/collect-logs-main.js next to <root>/state.
      const layout = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
      );
      const root = path.resolve(
        values.root ??
          (existsSync(path.join(layout, "state"))
            ? path.join(layout, "state")
            : "data"),
      );
      const nativeBytes =
        values["native-bytes"] === undefined
          ? undefined
          : Number(values["native-bytes"]);
      if (
        nativeBytes !== undefined &&
        (!Number.isSafeInteger(nativeBytes) || nativeBytes < 0)
      )
        throw new Error("--native-bytes must be a non-negative integer");
      const result = await collectLogs({
        root,
        out:
          values.out ??
          path.join(path.dirname(root), `logs-${timestamp(new Date())}.zip`),
        ...(nativeBytes === undefined ? {} : { nativeBytes }),
      });
      console.log(
        JSON.stringify({
          event: "logs.collected",
          zip: result.out,
          files: result.files.length,
          harnesshub: result.files.filter((file) => file.kind === "harnesshub")
            .length,
          skipped: result.skipped.length,
        }),
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "logs.collect_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}
