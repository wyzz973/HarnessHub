import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { at, record, type ConfigFormat } from "./formats.js";
import { appendJsonItem, appendTomlBlock, appendYamlItem, onlyChanged, parsed, removeJsonItem, removeTomlBlock, removeYamlItem, setJson, setTomlKey, tomlBlocks, UnsafeEdit, type KeyPath } from "./edits.js";
import type { LedgerEntry } from "./store.js";

/** Turning one skill off or on in one Harness's own switch (ADR-045 §4). `folder` is the copy Codex switches by its path. */
export interface SwitchRequest { readonly harnessId: string; readonly name: string; readonly enabled: boolean; readonly folder: string | null }
export type Owner = "harnesshub" | "other" | "none";
/** `ledger`: record the setting as HarnessHub's (`set`), or forget it because what it holds now is not HarnessHub's (`drop`). */
interface Common { readonly file: string; readonly key: string; readonly written: unknown; readonly previous: string | null; readonly current: Owner; readonly notes: readonly string[]; readonly ledger: "set" | "drop" }
/**
 * What a switch needs: nothing (already so), an edit of the file whose result `check` verifies against the parse before
 * it, or the Harness's own command whose result `check` verifies. `written` is the value the setting holds afterwards
 * (undefined: removed), recorded in the ledger with `previous`, the value before.
 */
export type SwitchPlan =
  | { readonly kind: "none"; readonly file: string; readonly reason: string }
  | (Common & { readonly kind: "edit"; readonly format: ConfigFormat; readonly after: string; readonly check: (before: unknown, after: unknown) => boolean })
  | (Common & { readonly kind: "command"; readonly args: readonly string[]; readonly check: (after: unknown) => boolean; readonly comments: boolean });
/** The ledger lookup of a setting and the hash the ledger records for a value. */
export interface SwitchContext { readonly ledger: (file: string, key: string) => LedgerEntry | null; readonly hash: (value: unknown) => string }

function own(value: Readonly<Record<string, unknown>>, key: string): unknown { return Object.hasOwn(value, key) ? value[key] : undefined; }
function plain(value: unknown): unknown { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as unknown; }
function list(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
function owner(entry: LedgerEntry | null, current: unknown, context: SwitchContext): Owner {
  return current === undefined ? "none" : entry !== null && entry.valueHash === context.hash(current) ? "harnesshub" : "other";
}
function none(file: string, reason: string): SwitchPlan { return { kind: "none", file, reason }; }

/** Claude Code: `skillOverrides.<name>` in settings.json, "off" to turn it off; turning it on restores what HarnessHub replaced. */
export function claudeSwitch(file: string, text: string, request: SwitchRequest, context: SwitchContext): SwitchPlan {
  const path: KeyPath = ["skillOverrides", request.name], current = own(record(at(parsed(text, "jsonc"), ["skillOverrides"])), request.name), key = path.join("/");
  const entry = context.ledger(file, key), by = owner(entry, current, context);
  const holds = (value: unknown, expected: unknown) => isDeepStrictEqual(plain(own(record(at(value, ["skillOverrides"])), request.name)), plain(expected));
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
  const skill = join(request.folder, "SKILL.md"), key = "skills.config/" + skill, blocks = tomlBlocks(text, "skills.config").filter(block => block.keys.get("path")?.value === skill);
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
  const current = typeof rule === "string" ? undefined : own(record(rule), request.name), entry = context.ledger(file, key), by = owner(entry, current, context);
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
  const value = parsed(text, "json5"), current = record(own(record(at(value, ["skills", "entries"])), request.name)).enabled, key = "skills.entries/" + request.name;
  const entry = context.ledger(file, key), by = owner(entry, current === false ? false : undefined, context), target = "skills.entries." + request.name + ".enabled";
  let comments = false;
  if (text.trim()) { try { JSON.parse(text); } catch { comments = true; } }
  const notes = ["由 OpenClaw 自己的命令写入：它会把 openclaw.json 整份重写，并可能补上它自己的默认项；下面的改动是先在副本上运行同一条命令得到的。",
    "正在运行的 OpenClaw Gateway（飞书、微信等频道）不会被 HarnessHub 重启；按 OpenClaw 的文档，技能设置下一轮就生效，命令里“重启 Gateway”的提示对技能设置不是必需的。",
    ...(comments ? ["文件里的注释和 JSON5 写法会丢失。"] : [])];
  const state = (after: unknown) => record(own(record(at(after, ["skills", "entries"])), request.name)).enabled;
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
