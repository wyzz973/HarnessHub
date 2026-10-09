import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { builtinRecipes } from "../adapters/recipes.js";
import { DiscoverHarnesses } from "../contexts/catalog/application/discover.js";
import {
  DiscoveryInputError,
  MAX_MANIFEST_BYTES,
  parseDiscoveryManifest,
  type DiscoveryManifest,
} from "../contexts/catalog/domain/discovery.js";
import { LocalExecutableLocator, searchDirectories } from "../infrastructure/discovery/local.js";

/** Read one explicit regular manifest with a byte cap before and during reading. */
export async function readManifest(path: string): Promise<DiscoveryManifest> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES)
      throw new DiscoveryInputError("manifest must be a regular file of at most 64 KiB");
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MAX_MANIFEST_BYTES)
      throw new DiscoveryInputError("manifest grew beyond 64 KiB");
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead))) as unknown;
    } catch {
      throw new DiscoveryInputError("manifest must contain valid UTF-8 JSON");
    }
    return parseDiscoveryManifest(value);
  } finally {
    await handle.close();
  }
}

export async function main(args: readonly string[]): Promise<number> {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: {
        json: { type: "boolean" },
        manifest: { type: "string" },
        "search-dir": { type: "string", multiple: true },
        "path-only": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      process.stdout.write("HarnessGateway discovery\n\n--json                 输出结构化检测报告\n--manifest <file>      追加配方与显式入口覆盖\n--search-dir <path>    追加绝对搜索目录，可重复\n--path-only            忽略常见目录，仅用PATH与显式目录\n\n只读检测，不执行Harness、不调用模型、不自动安装。\n");
      return 0;
    }
    if (values.manifest === "") throw new DiscoveryInputError("--manifest must name a file");
    const manifest =
      values.manifest === undefined
        ? { recipes: [], overrides: new Map() }
        : await readManifest(resolve(values.manifest));
    const search = searchDirectories({
      path: process.env.PATH ?? "",
      home: homedir(),
      extra: values["search-dir"] ?? [],
      pathOnly: values["path-only"] ?? false,
    });
    const service = new DiscoverHarnesses(new LocalExecutableLocator(search.directories), () => new Date());
    const report = {
      ...(await service.execute([...builtinRecipes, ...manifest.recipes], manifest.overrides)),
      searchNotes: search.notes,
    };
    if (values.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    else {
      process.stdout.write("HarnessGateway · 本机Harness检测\n");
      for (const harness of report.harnesses) {
        const label =
          harness.control.state === "harness_missing"
            ? "未找到可执行入口"
            : harness.control.state === "adapter_missing"
              ? "程序已找到，缺少适配器"
              : "入口已解析，协议待探测";
        process.stdout.write(harness.name + " — " + label + " [" + harness.control.protocol + "]\n");
      }
      process.stdout.write("\n本次未启动程序、未查询版本或登录、未调用模型。\n");
    }
    return 0;
  } catch (error: unknown) {
    process.stderr.write("HarnessGateway: " + (error instanceof Error ? error.message : "discovery failed") + "\n");
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
