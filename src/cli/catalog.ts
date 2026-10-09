import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { loadBuiltinCatalog } from "../adapters/catalog.js";

/** Map Node host labels to the upstream registry labels; no release/version matrix is implied. */
export function catalogTarget(platform: string = process.platform, architecture: string = process.arch): string {
  const os = platform === "win32" ? "windows" : platform;
  const arch = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : architecture;
  if (!["darwin", "linux", "windows"].includes(os) || !["aarch64", "x86_64"].includes(arch))
    throw new Error("unsupported catalog host: " + platform + "/" + architecture);
  return os + "-" + arch;
}

/** Display the fixed offline catalog; this command does not inspect installations. */
export async function main(args: readonly string[]): Promise<number> {
  try {
    const { values } = parseArgs({ args: [...args], options: { json: { type: "boolean" }, help: { type: "boolean", short: "h" } }, strict: true, allowPositionals: false });
    if (values.help) { process.stdout.write("HarnessGateway catalog [--json]\n固定离线目录，不等于本机安装或执行支持。\n"); return 0; }
    const definitions = loadBuiltinCatalog(catalogTarget());
    if (values.json) process.stdout.write(JSON.stringify({ schemaVersion: 2, definitions }, null, 2) + "\n");
    else {
      for (const item of definitions) process.stdout.write(item.id + " · " + item.name + " · " + item.controls.map((control) => control.id + ":" + control.protocol).join(", ") + "\n");
      process.stdout.write("\n" + definitions.length + "个产品描述；实际入口和依赖请运行 discover。\n");
    }
    return 0;
  } catch (error: unknown) {
    process.stderr.write("HarnessGateway: " + (error instanceof Error ? error.message : "catalog failed") + "\n"); return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
