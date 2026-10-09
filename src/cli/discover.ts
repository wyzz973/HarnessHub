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
import { loadBuiltinCatalog } from "../adapters/catalog.js";
import { migrateLegacyManifest, parseCatalogManifest, validateDefinitions } from "../contexts/catalog/domain/catalog-parser.js";
import { MAX_CATALOG_BYTES, type CatalogManifest, type HarnessDefinition, type InventoryReport } from "../contexts/catalog/domain/catalog.js";
import { DiscoverInventory } from "../contexts/catalog/application/inventory.js";
import { discoverSearchDirectories } from "../infrastructure/discovery/search.js";
import { LocalInstallationEnumerator } from "../infrastructure/discovery/installation-enumerator.js";
import { LocalInstalledPackageResolver } from "../infrastructure/discovery/packages.js";
import { LocalConfigurationLocator } from "../infrastructure/discovery/configuration.js";
import { catalogTarget } from "./catalog.js";

/** Read one explicit regular manifest with a byte cap before and during reading. */
export async function readManifest(path: string): Promise<DiscoveryManifest> {
  return parseDiscoveryManifest((await readJsonDocument(path, MAX_MANIFEST_BYTES)).value);
}

async function readJsonDocument(path: string, limit: number): Promise<{ readonly value: unknown; readonly bytes: number }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit)
      throw new DiscoveryInputError("manifest must be a regular file of at most " + (limit / 1024) + " KiB");
    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > limit)
      throw new DiscoveryInputError("manifest grew beyond " + (limit / 1024) + " KiB");
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead))) as unknown;
    } catch {
      throw new DiscoveryInputError("manifest must contain valid UTF-8 JSON");
    }
    return { value, bytes: bytesRead };
  } finally {
    await handle.close();
  }
}

async function legacyMain(args: readonly string[]): Promise<number> {
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

export interface InventoryInput {
  readonly manifest?: string;
  readonly searchDirs: readonly string[];
  readonly packageRoots: readonly string[];
  readonly pathOnly: boolean;
}

/** Shared CLI composition; callers receive one immutable catalog and its read-only observations. */
export async function inventory(input: InventoryInput): Promise<{
  readonly definitions: readonly HarnessDefinition[];
  readonly report: InventoryReport;
  readonly searchDiagnostics: Awaited<ReturnType<typeof discoverSearchDirectories>>["diagnostics"];
  readonly searchPath: string;
}> {
  const builtins = loadBuiltinCatalog(catalogTarget());
  if (input.manifest === "") throw new DiscoveryInputError("--manifest must name a file");
  let manifest: CatalogManifest = { version: 2, definitions: [], overrides: new Map(), installationOverrides: new Map() };
  if (input.manifest !== undefined) {
    const document = await readJsonDocument(resolve(input.manifest), MAX_CATALOG_BYTES);
    const value = document.value;
    if (value !== null && typeof value === "object" && "version" in value && value.version === 1) {
      if (document.bytes > MAX_MANIFEST_BYTES) throw new DiscoveryInputError("v1 manifest exceeds 64 KiB");
      manifest = migrateLegacyManifest(parseDiscoveryManifest(value), builtins);
    } else manifest = parseCatalogManifest(value);
  }
  const definitions = [...builtins, ...manifest.definitions];
  validateDefinitions(definitions);
  const search = await discoverSearchDirectories({
    path: process.env.PATH ?? "", home: homedir(), extra: input.searchDirs,
    pathOnly: input.pathOnly, environment: process.env,
  });
  const enumerator = new LocalInstallationEnumerator(search.directories);
  const service = new DiscoverInventory(
    enumerator, new LocalInstalledPackageResolver(input.packageRoots, enumerator),
    new LocalConfigurationLocator(homedir()), () => new Date(),
  );
  return {
    definitions, report: await service.execute(definitions, manifest.overrides, manifest.installationOverrides),
    searchDiagnostics: search.diagnostics,
    searchPath: search.directories.map((directory) => directory.path).join(":") ,
  };
}

export async function main(args: readonly string[]): Promise<number> {
  if (args.includes("--legacy")) return legacyMain(args.filter((arg) => arg !== "--legacy"));
  try {
    const { values } = parseArgs({ args: [...args], options: {
      json: { type: "boolean" }, manifest: { type: "string" },
      "search-dir": { type: "string", multiple: true }, "package-root": { type: "string", multiple: true },
      "path-only": { type: "boolean" }, help: { type: "boolean", short: "h" },
    }, strict: true, allowPositionals: false });
    if (values.help) {
      process.stdout.write("HarnessGateway · Harness发现\n--json 结构化v2报告；--legacy 保留v1输出\n--manifest <file> v1/v2描述\n--search-dir <absolute> 指定搜索目录\n--package-root <absolute> 已安装npm包的根，可重复\n--path-only 仅PATH与指定目录\n只读检测，不启动程序、不查询登录、不下载依赖。\n");
      return 0;
    }
    const result = await inventory({
      ...(values.manifest === undefined ? {} : { manifest: values.manifest }),
      searchDirs: values["search-dir"] ?? [], packageRoots: values["package-root"] ?? [], pathOnly: values["path-only"] ?? false,
    });
    const report = { ...result.report, searchDiagnostics: result.searchDiagnostics };
    if (values.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    else {
      process.stdout.write("HarnessGateway · 本机Harness发现（" + report.harnesses.length + "个产品描述）\n");
      for (const harness of report.harnesses) {
        const ready = harness.controls.filter((control) => control.state === "candidate");
        const blocked = harness.controls.some((control) => control.state === "blocked");
        const label = ready.length > 0 ? "控制入口已解析，协议待探测" : blocked ? "默认入口损坏，需明确处理" : harness.installation.candidates.length > 0 ? "发现程序，缺控制依赖" : harness.configuration.length > 0 ? "仅发现配置线索" : "未发现本地入口";
        process.stdout.write(harness.name + " [" + harness.id + "] — " + label + "\n");
      }
      if (result.searchDiagnostics.some((note) => note.code === "scan_truncated")) process.stdout.write("搜索范围达到上限，本次结果为部分观察。\n");
      process.stdout.write("\n本次未启动程序、未验证协议、未调用模型。\n");
    }
    return 0;
  } catch (error: unknown) {
    process.stderr.write("HarnessGateway: " + (error instanceof Error ? error.message : "inventory failed") + "\n");
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
