import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { at, record, type ConfigFormat } from "./formats.js";
import { appendJsonItem, appendTomlBlock, appendYamlItem, oneLineChange, onlyChanged, parsed, removeJsonItem, removeTomlBlock, removeYamlItem, setJson, setTomlKey, tomlBlocks, tomlTable, UnsafeEdit, type KeyPath } from "./edits.js";
import type { LedgerEntry } from "./store.js";
import { ownedOf, type McpStyle } from "./mcp-definitions.js";
import { mcpEntry, mcpLocation } from "./mcp-edits.js";
import { findBlock } from "./instruction-blocks.js";

/** Turning one skill off or on in one Harness's own switch (ADR-045 §4). `folder` is the copy Codex switches by its path. */
export interface SwitchRequest { readonly harnessId: string; readonly name: string; readonly enabled: boolean; readonly folder: string | null }
/** Turning one plugin (`name@marketplace`) off or on in one Harness's own file (ADR-045 step 6a). */
export interface PluginSwitchRequest { readonly harnessId: string; readonly id: string; readonly enabled: boolean }
export type Owner = "harnesshub" | "other" | "none";
/** `ledger`: record the setting as HarnessHub's (`set`), or forget it because what it holds now is not HarnessHub's (`drop`). */
interface Common { readonly file: string; readonly key: string; readonly written: unknown; readonly previous: string | null; readonly current: Owner; readonly notes: readonly string[]; readonly ledger: "set" | "drop";
  /** Other ledger entries of the same Harness the change records once it is applied: a stale one it drops, or a fact about a file it sets. */
  readonly alsoLedger?: readonly { readonly file: string; readonly key: string; readonly action: "set" | "drop" }[] }
/**
 * What a switch needs: nothing (already so), an edit of the file whose result `check` verifies against the parse before
 * it, or the Harness's own command whose result `check` verifies. `written` is the value the setting holds afterwards
 * (undefined: removed), recorded in the ledger with `previous`, the value before.
 */
export type SwitchPlan =
  | { readonly kind: "none"; readonly file: string; readonly reason: string }
  /**
   * `remove`: the file is deleted instead of written (`after` is then empty); only for a file HarnessHub created and
   * nothing else is in. `directory`: the file's directory is created first (`create`, 0700; its parent must exist), or
   * removed after the file when nothing else is left in it (`remove`) — for a directory HarnessHub created.
   */
  | (Common & { readonly kind: "edit"; readonly format: ConfigFormat; readonly after: string; readonly remove?: boolean; readonly directory?: "create" | "remove"; readonly check: (before: unknown, after: unknown) => boolean })
  | (Common & { readonly kind: "command"; readonly args: readonly string[]; readonly check: (after: unknown) => boolean; readonly comments: boolean;
    /**
     * Claude Code's own commands (`runner: "claude"`) instead of OpenClaw's: `steps` run in order (an update removes and
     * adds), and only `subtree` of its file must be as the check saw it, since running sessions rewrite the rest.
     */
    readonly runner?: "claude"; readonly steps?: readonly (readonly string[])[]; readonly subtree?: readonly string[] });
/** The ledger lookup of a setting and the hash the ledger records for a value. */
export interface SwitchContext { readonly ledger: (file: string, key: string) => LedgerEntry | null; readonly hash: (value: unknown) => string }

function own(value: Readonly<Record<string, unknown>>, key: string): unknown { return Object.hasOwn(value, key) ? value[key] : undefined; }
function plain(value: unknown): unknown { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as unknown; }
function list(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
function owner(entry: LedgerEntry | null, current: unknown, context: SwitchContext): Owner {
  return current === undefined ? "none" : entry !== null && entry.valueHash === context.hash(current) ? "harnesshub" : "other";
}
function none(file: string, reason: string): SwitchPlan { return { kind: "none", file, reason }; }
// What each switch reads as a skill's current setting, shared with `heldValue`.
function overrideOf(value: unknown, name: string): unknown { return own(record(at(value, ["skillOverrides"])), name); }
function skillRuleOf(value: unknown, name: string): unknown { const rule = at(value, ["permission", "skill"]); return typeof rule === "string" ? undefined : own(record(rule), name); }
function entryEnabledOf(value: unknown, name: string): unknown { return record(own(record(at(value, ["skills", "entries"])), name)).enabled; }
function copiesOf(text: string, skill: string): ReturnType<typeof tomlBlocks> { return tomlBlocks(text, "skills.config").filter(block => block.keys.get("path")?.value === skill); }
function pluginEntryOf(value: unknown, id: string): unknown { return own(record(at(value, ["enabledPlugins"])), id); }
function pluginTableOf(value: unknown, id: string): unknown { return own(record(at(value, ["plugins"])), id); }
/** Hermes's `skills.external_dirs` as a list of strings; Hermes reads a single string as a list of one. */
export function externalDirsOf(value: unknown): readonly string[] { const raw = at(value, ["skills", "external_dirs"]); return (typeof raw === "string" ? [raw] : list(raw)).map(item => String(item)); }

/** Claude Code: `skillOverrides.<name>` in settings.json, "off" to turn it off; turning it on restores what HarnessHub replaced. */
export function claudeSwitch(file: string, text: string, request: SwitchRequest, context: SwitchContext): SwitchPlan {
  const path: KeyPath = ["skillOverrides", request.name], current = overrideOf(parsed(text, "jsonc"), request.name), key = path.join("/");
  const entry = context.ledger(file, key), by = owner(entry, current, context);
  const holds = (value: unknown, expected: unknown) => isDeepStrictEqual(plain(overrideOf(value, request.name)), plain(expected));
  if (!request.enabled) {
    if (current === "off") return none(file, "Claude Code 里它已经是 off。");
    return { kind: "edit", file, format: "jsonc", after: setJson(text, path, "off"), key, written: "off", previous: current === undefined ? null : JSON.stringify(current), current: by, ledger: "set",
      notes: typeof current === "string" ? ["原来是 " + current + "；停用后改成 off，之后在这里启用会改回 " + current + "。"] : [], check: (before, after) => onlyChanged(before, after, path) && holds(after, "off") };
  }
  if (current !== "off") return none(file, "Claude Code 没有用 skillOverrides 关掉它。");
  const restore = by === "harnesshub" && entry?.previous != null ? JSON.parse(entry.previous) as unknown : undefined;
  return { kind: "edit", file, format: "jsonc", after: setJson(text, path, restore), key, written: restore, previous: JSON.stringify(current), current: by, ledger: "drop",
    notes: by === "harnesshub" ? [] : ["这个 off 不是 HarnessHub 写的（可能是在 Claude Code 里关掉的），启用会删掉它。"], check: (before, after) => onlyChanged(before, after, path) && holds(after, restore) };
}

/** Codex: one `[[skills.config]]` element per copy, by the path of its SKILL.md, with `enabled = false`. */
export function codexSwitch(file: string, text: string, request: SwitchRequest, context: SwitchContext): SwitchPlan {
  if (request.folder === null) throw new UnsafeEdit("Codex 按技能所在的路径停用，缺少路径");
  const skill = join(request.folder, "SKILL.md"), key = "skills.config/" + skill, blocks = copiesOf(text, skill);
  const off = blocks.filter(block => block.keys.get("enabled")?.value === false), entry = context.ledger(file, key), by = owner(entry, off.length ? false : undefined, context);
  const others = (value: unknown) => plain(list(at(value, ["skills", "config"])).filter(item => record(item).path !== skill));
  const matching = (value: unknown) => list(at(value, ["skills", "config"])).filter(item => record(item).path === skill);
  if (!request.enabled) {
    if (off.length) return none(file, "Codex 里这份已经停用。");
    const after = blocks[0] ? setTomlKey(text, blocks[0], "enabled", false) : appendTomlBlock(text, "skills.config", [["path", skill], ["enabled", false]]);
    return { kind: "edit", file, format: "toml", after, key, written: false, previous: blocks[0] ? JSON.stringify(blocks[0].keys.get("enabled")?.value ?? null) : null, current: by, ledger: "set",
      notes: ["改 config.toml 后要重启 Codex 才生效。", "Codex 按完整路径找这份技能；差异里的 ~ 代表你的家目录，写入的是完整路径。"],
      check: (before, after) => onlyChanged(before, after, ["skills", "config"]) && isDeepStrictEqual(others(before), others(after)) && matching(after).some(item => record(item).enabled === false) };
  }
  if (!off.length) return none(file, "Codex 没有在 config.toml 里停用这份。");
  let after = text;
  for (const block of [...off].reverse()) after = [...block.keys.keys()].every(name => name === "path" || name === "enabled") ? removeTomlBlock(after, block) : setTomlKey(after, block, "enabled", true);
  return { kind: "edit", file, format: "toml", after, key, written: undefined, previous: "false", current: by, ledger: "drop", notes: ["改 config.toml 后要重启 Codex 才生效。", "差异里的 ~ 代表你的家目录。"],
    check: (before, after) => onlyChanged(before, after, ["skills", "config"]) && isDeepStrictEqual(others(before), others(after)) && !matching(after).some(item => record(item).enabled === false) };
}

/** Gemini CLI (settings.json) and Hermes (config.yaml): the name in `skills.disabled`. */
export function listSwitch(file: string, text: string, format: "jsonc" | "yaml", request: SwitchRequest, context: SwitchContext, notes: readonly string[]): SwitchPlan {
  const path = ["skills", "disabled"] as const, value = at(parsed(text, format), path);
  if (value !== undefined && value !== null && !Array.isArray(value)) throw new UnsafeEdit("skills.disabled 不是列表");
  const names = list(value), has = names.includes(request.name), key = path.join(".") + "/" + request.name, by = owner(context.ledger(file, key), has ? true : undefined, context);
  const expected = request.enabled ? names.filter(item => item !== request.name) : [...names, request.name];
  if (request.enabled !== has) return none(file, request.enabled ? "它不在 skills.disabled 里。" : "它已经在 skills.disabled 里。");
  const after = request.enabled ? (format === "yaml" ? removeYamlItem(text, path, request.name) : removeJsonItem(text, path, request.name))
    : format === "yaml" ? appendYamlItem(text, path, request.name) : appendJsonItem(text, path, request.name);
  return { kind: "edit", file, format, after, key, written: request.enabled ? undefined : true, previous: has ? "true" : null, current: by, ledger: request.enabled ? "drop" : "set", notes,
    check: (before, after) => onlyChanged(before, after, path) && isDeepStrictEqual(plain(list(at(after, path))), plain(expected)) };
}

/** OpenCode's permission for a skill across its configuration files in load order: the last matching pattern decides. */
export function opencodePermission(values: readonly unknown[], name: string): string | null {
  let action: string | null = null;
  for (const value of values) {
    const rule = at(value, ["permission", "skill"]);
    if (typeof rule === "string") action = rule;
    else for (const [pattern, decided] of Object.entries(record(rule))) if (typeof decided === "string" && new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".") + "$", "u").test(name)) action = decided;
  }
  return action;
}
/** The last OpenCode rule that denies a skill, as written (`"be*": "deny"`), or null when none does. */
function denyingRule(values: readonly unknown[], name: string): string | null {
  let found: string | null = null;
  for (const value of values) {
    const rule = at(value, ["permission", "skill"]);
    if (typeof rule === "string") found = rule === "deny" ? "\"skill\": \"deny\"" : null;
    else for (const [pattern, decided] of Object.entries(record(rule))) if (opencodePermission([{ permission: { skill: { [pattern]: decided } } }], name) !== null) found = decided === "deny" ? JSON.stringify(pattern) + ": \"deny\"" : null;
  }
  return found;
}
/**
 * OpenCode: `permission.skill.<name>` in the last of its configuration files that exists (or a new opencode.json), set to
 * "deny"; a rule is moved to the end so it is the last that matches. Turning it on restores HarnessHub's replaced value
 * and adds "allow" only where another pattern still denies it. `earlier` are the parsed files loaded before this one.
 */
export function opencodeSwitch(file: string, text: string, earlier: readonly unknown[], request: SwitchRequest, context: SwitchContext): SwitchPlan {
  const value = parsed(text, "jsonc"), rule = at(value, ["permission", "skill"]), path: KeyPath = ["permission", "skill"], key = "permission.skill/" + request.name;
  const current = skillRuleOf(value, request.name), entry = context.ledger(file, key), by = owner(entry, current, context);
  const effective = (parse: unknown) => opencodePermission([...earlier, parse], request.name);
  const moveTo = (source: string, decided: string): string => {
    const skillRule = at(parsed(source, "jsonc"), path);
    if (typeof skillRule === "string") return setJson(source, path, { "*": skillRule, [request.name]: decided });
    return setJson(own(record(skillRule), request.name) === undefined ? source : setJson(source, [...path, request.name], undefined), [...path, request.name], decided);
  };
  const othersKept = (before: unknown, after: unknown) => {
    const left = at(before, path), right = at(after, path);
    if (typeof left === "string") return own(record(right), "*") === left && Object.keys(record(right)).every(name => name === "*" || name === request.name);
    const strip = (rules: unknown) => { const copy = { ...record(plain(rules)) }; delete copy[request.name]; return copy; };
    return isDeepStrictEqual(strip(left), strip(right));
  };
  if (!request.enabled) {
    if (effective(value) === "deny") return none(file, "OpenCode 的 permission.skill 已经拒绝它。");
    return { kind: "edit", file, format: "jsonc", after: moveTo(text, "deny"), key, written: "deny", previous: current === undefined ? null : JSON.stringify(current), current: by, ledger: "set",
      notes: ["OpenCode 不监视配置文件，重开后生效。"], check: (before, after) => onlyChanged(before, after, path) && othersKept(before, after) && effective(after) === "deny" };
  }
  if (effective(value) !== "deny") return none(file, "OpenCode 没有拒绝它。");
  // Only a "deny" of its own name is taken back; a user's "allow" or "ask" stays, moved last when another pattern still denies.
  let after = text, wroteAllow = false;
  if (current === "deny") after = setJson(after, [...path, request.name], by === "harnesshub" && entry?.previous != null ? JSON.parse(entry.previous) as unknown : undefined);
  const notes = ["OpenCode 不监视配置文件，重开后生效。"];
  if (effective(parsed(after, "jsonc")) === "deny") {
    const denying = denyingRule([...earlier, parsed(after, "jsonc")], request.name);
    after = moveTo(after, "allow"); wroteAllow = true;
    notes.push("你现有的规则 " + (denying ?? "permission.skill") + " 拒绝了它；启用会在末尾追加 " + JSON.stringify(request.name) + ": \"allow\" 覆盖它，这条 allow 记为 HarnessHub 写的。");
  }
  const written = own(record(at(parsed(after, "jsonc"), path)), request.name);
  return { kind: "edit", file, format: "jsonc", after, key, written, previous: current === undefined ? null : JSON.stringify(current), current: by, ledger: wroteAllow ? "set" : "drop", notes,
    check: (before, after) => onlyChanged(before, after, path) && othersKept(before, after) && effective(after) !== "deny" };
}

/**
 * OpenClaw: `skills.entries.<name>.enabled` through `openclaw config set|unset`, which rewrites openclaw.json as JSON and
 * may add its own defaults. Its dot path cannot name a skill with a dot (2026.3.23-2 keeps bracket quotes in the key).
 */
export function openclawSwitch(file: string, text: string, request: SwitchRequest, context: SwitchContext): SwitchPlan {
  // The name becomes part of a command-line argument: only plain identifiers go in (2026.3.23-2 keeps bracket quotes in keys).
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(request.name)) throw new UnsafeEdit("技能名里有点号或其他符号，OpenClaw 的 config 命令无法安全定位它");
  const value = parsed(text, "json5"), current = entryEnabledOf(value, request.name), key = "skills.entries/" + request.name;
  const entry = context.ledger(file, key), by = owner(entry, current === false ? false : undefined, context), target = "skills.entries." + request.name + ".enabled";
  let comments = false;
  if (text.trim()) { try { JSON.parse(text); } catch { comments = true; } }
  const notes = ["由 OpenClaw 自己的命令写入：它会把 openclaw.json 整份重写，并可能补上它自己的默认项；下面的改动是先在副本上运行同一条命令得到的。",
    "正在运行的 OpenClaw Gateway（飞书、微信等频道）不会被 HarnessHub 重启；按 OpenClaw 的文档，技能设置下一轮就生效，命令里“重启 Gateway”的提示对技能设置不是必需的。",
    ...(comments ? ["文件里的注释和 JSON5 写法会丢失。"] : [])];
  const state = (after: unknown) => entryEnabledOf(after, request.name);
  if (!request.enabled) {
    if (current === false) return none(file, "OpenClaw 里它已经停用。");
    return { kind: "command", file, args: ["config", "set", target, "false", "--strict-json"], key, written: false, previous: current === undefined ? null : JSON.stringify(current), current: by, ledger: "set", notes, comments,
      check: after => state(after) === false };
  }
  if (current !== false) return none(file, "OpenClaw 没有停用它。");
  const restore = by === "harnesshub" && entry?.previous === "true";
  return { kind: "command", file, args: restore ? ["config", "set", target, "true", "--strict-json"] : ["config", "unset", target], key, written: restore ? true : undefined, previous: "false", current: by, ledger: "drop", notes, comments,
    check: after => state(after) !== false };
}

/**
 * Claude Code: `enabledPlugins.<id>` in settings.json (ADR-045 step 6a), the key its own `/plugin` and `claude plugin
 * enable` write. `fallback` is whether the plugin is on without an entry (its `defaultEnabled`, or an enabled plugin
 * depending on it). Turning on a plugin HarnessHub turned off puts back the entry it replaced, unless that leaves the
 * plugin off (no entry and a default of off): then, as for anyone else's `false`, it writes true.
 */
export function claudePluginSwitch(file: string, text: string, request: PluginSwitchRequest, fallback: boolean, context: SwitchContext): SwitchPlan {
  const path: KeyPath = ["enabledPlugins", request.id], key = "plugin/" + request.id, current = pluginEntryOf(parsed(text, "jsonc"), request.id);
  if (current !== undefined && typeof current !== "boolean") throw new UnsafeEdit("enabledPlugins 里这一项不是 true 或 false");
  const entry = context.ledger(file, key), by = owner(entry, current, context);
  const holds = (value: unknown, expected: unknown) => isDeepStrictEqual(plain(pluginEntryOf(value, request.id)), plain(expected));
  const previous = current === undefined ? null : JSON.stringify(current);
  if (!request.enabled) {
    if (current === false) return none(file, "Claude Code 里它已经停用。");
    return { kind: "edit", file, format: "jsonc", after: setJson(text, path, false), key, written: false, previous, current: by, ledger: "set",
      notes: current === undefined ? ["enabledPlugins 里原来没有这一项（按默认" + (fallback ? "启用" : "停用") + "），停用会写入 false。"] : [], check: (before, after) => onlyChanged(before, after, path) && holds(after, false) };
  }
  if (current === true) return none(file, "Claude Code 里它已经启用。");
  if (current === undefined && fallback) return none(file, "Claude Code 按默认启用它（enabledPlugins 里没有这一项）。");
  if (by === "harnesshub" && current === false) {
    // HarnessHub's own `false`: the entry it replaced comes back, when that turns the plugin on.
    const original = entry?.previous == null ? undefined : JSON.parse(entry.previous) as unknown;
    if (original === true || (original === undefined && fallback))
      return { kind: "edit", file, format: "jsonc", after: setJson(text, path, original), key, written: original, previous, current: by, ledger: "drop",
        notes: original === undefined ? ["改回停用之前的样子：删掉 enabledPlugins 里的这一项，按默认启用。"] : [], check: (before, after) => onlyChanged(before, after, path) && holds(after, original) };
  }
  const why = current === undefined ? "这个插件默认停用，所以写入 true。" : by === "harnesshub" ? "停用之前 enabledPlugins 里没有这一项，而它默认停用；删掉这一项不会启用它，所以写入 true。"
    : "这个 false 不是 HarnessHub 写的（可能是在 Claude Code 里停用的），启用会改成 true。";
  return { kind: "edit", file, format: "jsonc", after: setJson(text, path, true), key, written: true, previous, current: by, ledger: "set", notes: [why],
    check: (before, after) => onlyChanged(before, after, path) && holds(after, true) };
}

/**
 * Codex: `enabled` in its `[plugins."<id>"]` table (ADR-045 step 6a), the key its own `/plugins` writes: the value is
 * replaced in place, or the key added after the table's last key, so exactly one line changes. A plugin defined some
 * other way (dotted keys, an inline table) is refused, and no second table is ever added. Codex's default for a table
 * without `enabled` is not verified, so turning a plugin on writes `enabled = true` rather than removing the line.
 */
export function codexPluginSwitch(file: string, text: string, request: PluginSwitchRequest, context: SwitchContext, notes: readonly string[]): SwitchPlan {
  const value = parsed(text, "toml"), key = "plugin/" + request.id, path: KeyPath = ["plugins", request.id, "enabled"];
  if (pluginTableOf(value, request.id) === undefined) throw new UnsafeEdit("config.toml 里没有这个插件");
  const table = tomlTable(text, ["plugins", request.id]);
  if (table === null) throw new UnsafeEdit("这个插件不是写成 [plugins.\"" + request.id + "\"] 表（可能写在 [plugins] 下，或写成了内联表），HarnessHub 不改写它的写法");
  const current = record(pluginTableOf(value, request.id)).enabled;
  if (current !== undefined && typeof current !== "boolean") throw new UnsafeEdit("enabled 不是 true 或 false");
  const entry = context.ledger(file, key), by = owner(entry, current, context), previous = current === undefined ? null : JSON.stringify(current);
  const plan = (written: boolean, ledger: "set" | "drop", extra: readonly string[]): SwitchPlan => {
    const after = setTomlKey(text, table, "enabled", written);
    if (!oneLineChange(text, after)) throw new UnsafeEdit("改动超出了一行");
    return { kind: "edit", file, format: "toml", after, key, written, previous, current: by, ledger, notes: [...notes, ...extra],
      check: (before, after) => onlyChanged(before, after, path) && record(pluginTableOf(after, request.id)).enabled === written };
  };
  if (!request.enabled) return current === false ? none(file, "Codex 里它已经停用。") : plan(false, "set", current === undefined ? ["这张表里原来没有 enabled（Codex 的缺省值没有核实），停用会加上 enabled = false。"] : []);
  if (current === true) return none(file, "Codex 里它已经启用。");
  // HarnessHub's own `false` over an explicit `true` goes back to it; over a missing key it stays explicit (default unverified).
  if (by === "harnesshub" && current === false && entry?.previous === "true") return plan(true, "drop", []);
  return plan(true, "set", current === undefined ? ["这张表里原来没有 enabled（Codex 的缺省值没有核实），启用会写明 enabled = true。"]
    : by === "harnesshub" ? ["停用之前这张表里没有 enabled；Codex 的缺省值没有核实，所以写明 enabled = true，不删这一行。"] : ["这个 false 不是 HarnessHub 写的（可能是在 Codex 里停用的），启用会改成 true。"]);
}

/**
 * Hermes reads the shared directory through `skills.external_dirs` (ADR-045 §4, approval ruling 2): `present` adds
 * `entry` when no listed directory resolves to it (`resolves`), otherwise removes every one that does. Hermes accepts a
 * single string there too; that form is left to the user rather than rewritten.
 */
export function sharedDirPlan(file: string, text: string, present: boolean, entry: string, resolves: (raw: string) => boolean, context: SwitchContext, notes: readonly string[]): SwitchPlan {
  const path = ["skills", "external_dirs"] as const, value = at(parsed(text, "yaml"), path);
  if (typeof value === "string") throw new UnsafeEdit("skills.external_dirs 写成了单个字符串，HarnessHub 不改写它的形式");
  if (value !== undefined && value !== null && !Array.isArray(value)) throw new UnsafeEdit("skills.external_dirs 不是列表");
  const listed = list(value).map(item => String(item)), matching = listed.filter(resolves), key = "skills.external_dirs/shared";
  const by = owner(context.ledger(file, key), matching.length ? matching : undefined, context);
  if (present === matching.length > 0) return none(file, present ? "Hermes 已经读取共享目录。" : "Hermes 没有读取共享目录。");
  const expected = present ? [...listed, entry] : listed.filter(item => !resolves(item));
  const after = present ? appendYamlItem(text, path, entry) : matching.reduce((source, raw) => removeYamlItem(source, path, raw), text);
  return { kind: "edit", file, format: "yaml", after, key, written: present ? [entry] : undefined, previous: matching.length ? JSON.stringify(matching) : null, current: by, ledger: present ? "set" : "drop", notes,
    check: (before, after) => onlyChanged(before, after, path) && isDeepStrictEqual(plain(list(at(after, path)).map(item => String(item))), plain(expected)) };
}

/** The parser of each Harness's switch file. */
const SWITCH_FORMATS: Readonly<Record<string, ConfigFormat>> = { claude: "jsonc", codex: "toml", gemini: "jsonc", hermes: "yaml", opencode: "jsonc", openclaw: "json5" };
function isMcpStyle(harnessId: string): harnessId is McpStyle { return ["claude", "codex", "cursor", "opencode", "gemini", "hermes", "dsh"].includes(harnessId); }
/**
 * What a ledger key holds in its file now, read as the switch that wrote it reads it (undefined: not there), so HarnessHub
 * can tell whether the value it wrote is still in place. `shared` tells which entries of Hermes's `skills.external_dirs`
 * are the shared directory. Throws `UnsafeEdit` for a key this build does not write, and the parser's error for a file
 * that does not parse.
 */
export function heldValue(harnessId: string, key: string, text: string, shared: (raw: string) => boolean): unknown {
  const slash = key.indexOf("/"), prefix = key.slice(0, slash), rest = key.slice(slash + 1);
  // An MCP server HarnessHub wrote: its owned keys, read the way its writer reads them.
  if (prefix === "mcp" && rest && isMcpStyle(harnessId)) { const style = harnessId; return ownedOf(mcpEntry(parsed(text, mcpLocation(style).format), style, rest), style); }
  // A subagent file HarnessHub wrote: the whole file is HarnessHub's, so its text is the value.
  if (prefix === "subagent" && rest) return text;
  // A plugin switch: Claude Code's `enabledPlugins.<id>`, Codex's `enabled` in the plugin's table (undefined: not there).
  if (prefix === "plugin" && rest && harnessId === "claude") return pluginEntryOf(parsed(text, "jsonc"), rest);
  if (prefix === "plugin" && rest && harnessId === "codex") { const table = pluginTableOf(parsed(text, "toml"), rest); return table === undefined ? undefined : record(table).enabled; }
  // HarnessHub's instructions block: its text; markers it cannot use make the file unreadable for it.
  if (prefix === "instructions" && rest === "block") { const block = findBlock(text); if (block.kind === "broken") throw new UnsafeEdit(block.reason); return block.kind === "block" ? block.body : undefined; }
  const format = SWITCH_FORMATS[harnessId];
  if (slash < 1 || !rest || format === undefined) throw new UnsafeEdit("台账里有这个版本不认识的设置");
  if (prefix === "skills.config" && harnessId === "codex") {
    parsed(text, "toml");
    const copies = copiesOf(text, rest);
    return copies.some(block => block.keys.get("enabled")?.value === false) ? false : copies[0] ? copies[0].keys.get("enabled")?.value ?? null : undefined;
  }
  const value = parsed(text, format);
  if (prefix === "skillOverrides" && harnessId === "claude") return overrideOf(value, rest);
  if (prefix === "skills.disabled" && (harnessId === "gemini" || harnessId === "hermes")) return list(at(value, ["skills", "disabled"])).includes(rest) ? true : undefined;
  if (prefix === "permission.skill" && harnessId === "opencode") return skillRuleOf(value, rest);
  if (prefix === "skills.entries" && harnessId === "openclaw") return entryEnabledOf(value, rest);
  if (prefix === "skills.external_dirs" && harnessId === "hermes") { const matching = externalDirsOf(value).filter(shared); return matching.length ? matching : undefined; }
  throw new UnsafeEdit("台账里有这个版本不认识的设置");
}
