import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ClaudeManagedSettings, PluginSource } from "../../adapters/capability-reads.js";
import { at, parseConfig, record, text } from "./formats.js";

/**
 * Claude Code's plugins as its documented rules decide them (ADR-045 step 6a; code.claude.com/docs/en/settings-reference
 * `enabledPlugins`, plugins/manifest-reference): which are installed for the user or synced from claude.ai, whether each
 * is on, what each depends on, and whether an organization's managed settings decide one. Read only.
 */

/** A plugin id as Claude Code and Codex write it: `name@marketplace`, each part letters, digits, `.`, `_` and `-`. */
export const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u;
/** Sources Claude Code loads plugins from without an install record; HarnessHub switches none of them in step 6a. */
export const CLAUDE_UNINSTALLED_SOURCES: readonly string[] = ["inline", "skills-dir", "builtin", "synced"];
const SYNCED_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;

type ClaudeSource = Extract<PluginSource, { kind: "claude" }>;
/** A JSON file as the model reads it: missing, unreadable (why), or parsed. */
export type PluginFileRead = { readonly state: "missing" } | { readonly state: "unreadable"; readonly reason: string } | { readonly state: "ok"; readonly value: unknown };
/** How the model reads files. `entries` throws for a directory it cannot read; `exists` is true for anything not plainly missing. */
export interface PluginFiles {
  readonly json: (path: string) => Promise<PluginFileRead>;
  /** A directory's entries, links followed to tell directories; null when it is missing. */
  readonly entries: (path: string) => Promise<readonly { readonly name: string; readonly directory: boolean }[] | null>;
  readonly exists: (path: string) => Promise<boolean>;
}
/** One plugin Claude Code has for the user: installed at user scope, or synced from claude.ai (`<name>@synced`). */
export interface ClaudePlugin {
  readonly id: string;
  readonly name: string;
  /** Its marketplace; for a synced plugin, the claude.ai marketplace it came from (bare dependencies resolve against it). */
  readonly marketplace: string;
  readonly synced: boolean;
  readonly version: string | null;
  readonly description: string | null;
  /** The user-level `enabledPlugins` entry: a boolean, undefined without one, `invalid` for any other value. */
  readonly entry: boolean | "invalid" | undefined;
  /** Whether it starts enabled without an entry: its marketplace entry's `defaultEnabled`, then plugin.json's, then true. */
  readonly defaultEnabled: boolean;
  /** The ids it depends on (both manifests together); null when they cannot be read, `problem` saying why. */
  readonly dependencies: readonly string[] | null;
  readonly problem: string | null;
}
export interface ClaudePlugins {
  readonly plugins: readonly ClaudePlugin[];
  /** The user-level `enabledPlugins` as written. */
  readonly entries: Readonly<Record<string, unknown>>;
  /** Plugins installed only in projects, which are not listed. */
  readonly projectOnly: number;
  /** `syncClaudeAiPlugins: false`: every synced plugin is off. */
  readonly syncOff: boolean;
  /** Whether each listed plugin is on: its entry, else its default; and on, unless the user set it, when an enabled plugin depends on it. */
  readonly enabled: ReadonlyMap<string, boolean>;
  /** Files that could not be used; a synced manifest is named without the account it belongs to. */
  readonly unreadable: readonly { readonly file: string; readonly reason: string }[];
}
/** What an organization's managed settings say about one plugin: nothing, on or off, or that HarnessHub cannot tell. */
export type ManagedPluginSetting = { readonly state: "none" } | { readonly state: "set"; readonly value: boolean; readonly file: string } | { readonly state: "unknown"; readonly reason: string };

function own(value: Readonly<Record<string, unknown>>, key: string): unknown { return Object.hasOwn(value, key) ? value[key] : undefined; }
function list(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
/** A description as written, whole (2026-11-12: it was cut at 400 characters). */
function clip(value: string | null): string | null { return value; }
function code(error: unknown): string { return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "未知错误"; }
/** The parts of `name@marketplace`, split at the last `@`. */
export function pluginParts(id: string): { readonly name: string; readonly marketplace: string } {
  const split = id.lastIndexOf("@");
  return split > 0 ? { name: id.slice(0, split), marketplace: id.slice(split + 1) } : { name: id, marketplace: "" };
}
/**
 * A manifest's `dependencies` as plugin ids: `"name"` (this plugin's marketplace), `"name@marketplace"`, or
 * `{ name, marketplace, version }`; a version constraint is not evaluated. A list HarnessHub cannot read is a problem.
 */
export function dependencyIds(raw: unknown, marketplace: string): readonly string[] | { readonly problem: string } {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return { problem: "dependencies 不是列表" };
  const out: string[] = [];
  for (const item of raw) {
    const id = typeof item === "string" ? (item.includes("@") ? item : item + "@" + marketplace)
      : item !== null && typeof item === "object" && typeof record(item).name === "string" ? record(item).name + "@" + (text(record(item).marketplace) ?? marketplace) : null;
    if (id === null || !PLUGIN_ID.test(id)) return { problem: "依赖 " + JSON.stringify(item).slice(0, 80) + " 的写法无法识别" };
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Reads the user's Claude Code plugins: installed at user scope (by its install record) and synced from claude.ai. */
export async function readClaudePlugins(source: ClaudeSource, files: PluginFiles): Promise<ClaudePlugins> {
  const unreadable: { file: string; reason: string }[] = [];
  const value = async (path: string, shownAs = path): Promise<unknown> => {
    const read = await files.json(path);
    if (read.state === "unreadable") { unreadable.push({ file: shownAs, reason: read.reason }); return undefined; }
    return read.state === "ok" ? read.value : undefined;
  };
  const settings = await value(source.settings), entries = record(at(settings, ["enabledPlugins"])), syncOff = at(settings, ["syncClaudeAiPlugins"]) === false;
  const entryOf = (id: string): boolean | "invalid" | undefined => { const entry = own(entries, id); return entry === undefined || typeof entry === "boolean" ? entry : "invalid"; };
  // Each marketplace's plugin entries by name, read once; a marketplace that cannot be read is a problem for its plugins.
  const known = record(await value(source.marketplaces)), catalogs = new Map<string, Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>> | { problem: string }>>();
  const catalog = (marketplace: string): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>> | { readonly problem: string }> => {
    let pending = catalogs.get(marketplace);
    if (pending === undefined) {
      pending = (async () => {
        const location = text(record(own(known, marketplace)).installLocation);
        if (location === null) return { problem: "Claude Code 的市场列表里没有 " + marketplace };
        const read = await files.json(join(location, ".claude-plugin", "marketplace.json"));
        if (read.state !== "ok") return { problem: "市场 " + marketplace + " 的清单" + (read.state === "missing" ? "不存在" : "读不到（" + read.reason + "）") };
        const byName = new Map<string, Readonly<Record<string, unknown>>>();
        for (const item of list(record(read.value).plugins)) { const name = text(record(item).name); if (name !== null && !byName.has(name)) byName.set(name, record(item)); }
        return byName;
      })();
      catalogs.set(marketplace, pending);
    }
    return pending;
  };
  const dependencies = (manifest: Readonly<Record<string, unknown>>, entry: Readonly<Record<string, unknown>>, marketplace: string): readonly string[] | { readonly problem: string } => {
    const left = dependencyIds(manifest.dependencies, marketplace), right = dependencyIds(entry.dependencies, marketplace);
    if ("problem" in left) return left;
    if ("problem" in right) return right;
    return [...new Set([...left, ...right])];
  };
  const plugins: ClaudePlugin[] = [];
  let projectOnly = 0;
  for (const [id, raw] of Object.entries(record(at(await value(source.installed), ["plugins"])))) {
    const installs = (Array.isArray(raw) ? raw : [raw]).map(record), user = installs.find(item => item.scope === undefined || item.scope === "user");
    if (user === undefined) { projectOnly++; continue; }
    const { name, marketplace } = pluginParts(id), directory = text(user.installPath);
    let problem: string | null = null, manifest: Readonly<Record<string, unknown>> = {}, entry: Readonly<Record<string, unknown>> = {};
    if (directory === null || !(await files.exists(directory))) problem = "它的安装目录不存在";
    else {
      // Without plugin.json the marketplace entry is the manifest (manifest-reference, “Marketplace entries and the manifest”).
      const read = await files.json(join(directory, ".claude-plugin", "plugin.json"));
      if (read.state === "unreadable") problem = "它的 plugin.json 读不到（" + read.reason + "）";
      else if (read.state === "ok") manifest = record(read.value);
    }
    const listed = await catalog(marketplace);
    if ("problem" in listed) problem ??= listed.problem; else entry = listed.get(name) ?? {};
    const found = dependencies(manifest, entry, marketplace);
    plugins.push({ id, name, marketplace, synced: false, version: text(user.version) ?? text(manifest.version), description: clip(text(entry.description) ?? text(manifest.description)), entry: entryOf(id),
      defaultEnabled: typeof entry.defaultEnabled === "boolean" ? entry.defaultEnabled : typeof manifest.defaultEnabled === "boolean" ? manifest.defaultEnabled : true,
      dependencies: problem !== null || "problem" in found ? null : found, problem: problem ?? ("problem" in found ? found.problem : null) });
  }
  // claude.ai's plugins: a manifest per account, each plugin's newest copy in `<name>~g<generation>` (`<name>` for the first).
  let buckets: readonly { readonly name: string; readonly directory: boolean }[] | null = null;
  try { buckets = await files.entries(source.synced); } catch (error) { unreadable.push({ file: source.synced, reason: "无法读取（" + code(error) + "）" }); }
  const synced = new Set<string>();
  for (const bucket of [...(buckets ?? [])].filter(item => item.directory && !item.name.startsWith(".")).sort((left, right) => left.name < right.name ? -1 : 1)) {
    const manifestOf = join(source.synced, bucket.name, "manifest.json"), listed = record(await value(manifestOf, join(source.synced, "<账户>", "manifest.json")));
    for (const item of list(listed.plugins)) {
      const row = record(item), name = text(row.name);
      if (name === null || !SYNCED_NAME.test(name) || synced.has(name)) continue;
      synced.add(name);
      const generation = typeof row.generation === "number" && Number.isInteger(row.generation) && row.generation > 1 ? row.generation : 1;
      const directory = join(source.synced, bucket.name, generation > 1 ? name + "~g" + generation : name), marketplace = text(row.marketplaceName) ?? "synced";
      const read = await files.json(join(directory, ".claude-plugin", "plugin.json")), manifest = read.state === "ok" ? record(read.value) : {};
      const found = dependencies(manifest, {}, marketplace), id = name + "@synced";
      plugins.push({ id, name, marketplace, synced: true, version: text(row.version) ?? text(manifest.version), description: clip(text(row.description) ?? text(manifest.description)), entry: entryOf(id),
        defaultEnabled: typeof manifest.defaultEnabled === "boolean" ? manifest.defaultEnabled : true,
        dependencies: read.state === "unreadable" || "problem" in found ? null : found,
        problem: read.state === "unreadable" ? "它的 plugin.json 读不到（" + read.reason + "）" : "problem" in found ? found.problem : null });
    }
  }
  const enabled = new Map<string, boolean>(plugins.map(plugin => [plugin.id, plugin.synced && syncOff ? false : typeof plugin.entry === "boolean" ? plugin.entry : plugin.defaultEnabled]));
  // A plugin that an enabled plugin depends on starts enabled regardless, when the user has not set it (manifest-reference `defaultEnabled`).
  for (let changed = true; changed;) {
    changed = false;
    for (const plugin of plugins) {
      if (!enabled.get(plugin.id)) continue;
      for (const dependency of plugin.dependencies ?? []) {
        const target = plugins.find(item => item.id === dependency);
        if (target !== undefined && target.entry === undefined && !(target.synced && syncOff) && !enabled.get(target.id)) { enabled.set(target.id, true); changed = true; }
      }
    }
  }
  return { plugins, entries, projectOnly, syncOff, enabled, unreadable };
}

/**
 * What Claude Code's managed settings say about one plugin, from the files HarnessHub can read: `managed-settings.json`,
 * then the `.json` files of `managed-settings.d` in name order, a later value replacing an earlier one. An MDM profile
 * that exists, or a file that cannot be read, makes it unknown; settings delivered from claude.ai cannot be told at all.
 */
export async function managedPluginSetting(managed: ClaudeManagedSettings, id: string, files: PluginFiles): Promise<ManagedPluginSetting> {
  for (const profile of managed.profiles) if (await files.exists(profile)) return { state: "unknown", reason: "这台电脑有 MDM 下发的 Claude Code 管理设置（" + profile + "），HarnessHub 不读它，无法确认它没有决定这个插件" };
  let dropIns: readonly { readonly name: string; readonly directory: boolean }[] | null;
  try { dropIns = await files.entries(managed.dropIns); } catch (error) { return { state: "unknown", reason: "管理设置目录 " + managed.dropIns + " 读不到（" + code(error) + "）" }; }
  const layers = [managed.file, ...(dropIns ?? []).filter(item => !item.directory && !item.name.startsWith(".") && item.name.endsWith(".json")).map(item => item.name).sort().map(name => join(managed.dropIns, name))];
  let found: { value: unknown; file: string } | null = null;
  for (const layer of layers) {
    const read = await files.json(layer);
    if (read.state === "unreadable") return { state: "unknown", reason: "管理设置 " + layer + " 读不到（" + read.reason + "）" };
    if (read.state === "ok") { const entry = own(record(at(read.value, ["enabledPlugins"])), id); if (entry !== undefined) found = { value: entry, file: layer }; }
  }
  if (found === null) return { state: "none" };
  return typeof found.value === "boolean" ? { state: "set", value: found.value, file: found.file } : { state: "unknown", reason: "管理设置 " + found.file + " 里这一项不是 true 或 false" };
}

/** The files of this computer, read without following anything but directory links, each JSON file at most 32 MB. */
export function systemPluginFiles(): PluginFiles {
  return {
    json: async path => {
      let info;
      try { info = await stat(path); } catch (error) { return code(error) === "ENOENT" || code(error) === "ENOTDIR" ? { state: "missing" } : { state: "unreadable", reason: "无法读取（" + code(error) + "）" }; }
      if (!info.isFile()) return { state: "unreadable", reason: "不是普通文件" };
      if (info.size > MAX_MANIFEST_BYTES) return { state: "unreadable", reason: "文件超过 32 MB，未读取" };
      let content: string;
      try { content = await readFile(path, "utf8"); } catch (error) { return { state: "unreadable", reason: "无法读取（" + code(error) + "）" }; }
      const parsed = parseConfig(content, "json");
      return parsed.ok ? { state: "ok", value: parsed.value } : { state: "unreadable", reason: parsed.reason };
    },
    entries: async path => {
      let items;
      try { items = await readdir(path, { withFileTypes: true }); } catch (error) { if (code(error) === "ENOENT" || code(error) === "ENOTDIR") return null; throw error; }
      return Promise.all(items.map(async item => ({ name: item.name, directory: item.isDirectory() || (item.isSymbolicLink() && await stat(join(path, item.name)).then(info => info.isDirectory(), () => false)) })));
    },
    exists: async path => { try { await stat(path); return true; } catch (error) { return code(error) !== "ENOENT" && code(error) !== "ENOTDIR"; } },
  };
}
