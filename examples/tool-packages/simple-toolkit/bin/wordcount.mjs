// Zero-dependency CLI for the simple-toolkit example. The managed command MCP
// starts it with the Session workspace as its working directory.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const results = [];
for (const name of process.argv.slice(2)) {
  const target = path.resolve(root, name);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    results.push({ path: name, error: "outside the workspace" });
    continue;
  }
  try {
    const info = await stat(target);
    if (!info.isFile() || info.size > 1024 * 1024) {
      results.push({ path: name, error: "not a file of at most 1 MiB" });
      continue;
    }
    const text = await readFile(target, "utf8");
    results.push({
      path: name,
      lines: text ? text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0) : 0,
      words: text.split(/\s+/).filter(Boolean).length,
      bytes: info.size,
    });
  } catch {
    results.push({ path: name, error: "not readable" });
  }
}
process.stdout.write(`${JSON.stringify({ cwd: root, results })}\n`);
process.exitCode = results.some((result) => result.error) ? 1 : 0;
