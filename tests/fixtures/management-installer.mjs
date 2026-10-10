import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [stage, name, version, bin, mode = "healthy"] = process.argv.slice(2);
if (!stage || !name || !version || !bin) throw new Error("fixture requires its owned target");
const root = join(stage, "node_modules", name);
await mkdir(root, { recursive: true });
await writeFile(join(root, "package.json"), JSON.stringify({ name, version: mode === "wrong-version" ? "0.0.0" : version, bin: { [bin]: "entry.mjs" } }));
if (mode !== "missing-bin") await writeFile(join(root, "entry.mjs"), "console.log(" + JSON.stringify(version) + ");\n");
if (mode === "wait") {
  console.log("WAIT_READY:" + process.pid);
  process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);
} else if (mode === "nonzero") { console.error("synthetic dependency failure"); process.exitCode = 7; }
else { console.log("INSTALL_DONE:" + process.pid); }
