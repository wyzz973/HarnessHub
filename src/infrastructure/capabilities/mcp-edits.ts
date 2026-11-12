import { isDeepStrictEqual } from "node:util";
import { isMap, isScalar, isSeq, parseDocument, stringify } from "yaml";
import { opencodeMcpServers } from "../../adapters/capability-reads.js";
import { parsed, setJson, UnsafeEdit } from "./edits.js";
import type { ConfigFormat } from "./formats.js";
import { at, parseConfig, record } from "./formats.js";
import { MCP_OWNED, ownedOf, type McpStyle } from "./mcp-definitions.js";

/**
 * Edits of one MCP server entry in a Harness's own file (ADR-045 §5): adding it, changing only the keys HarnessHub owns
 * (everything the user added to the entry stays), or removing it, with every other byte of the file kept. Each result is
 * checked to differ from the file before only at that entry.
 */

/** Where a Harness keeps its servers, and the format of its file. */
export function mcpLocation(style: McpStyle): { readonly path: readonly string[]; readonly format: ConfigFormat } {
  switch (style) {
    case "claude": case "cursor": case "gemini": return { path: ["mcpServers"], format: "jsonc" };
    case "opencode": return { path: ["mcp"], format: "jsonc" };
    case "opencode-v2": return { path: ["mcp", "servers"], format: "jsonc" };
    case "hermes": return { path: ["mcp_servers"], format: "yaml" };
    case "codex": return { path: ["mcp_servers"], format: "toml" };
    case "dsh": return { path: [], format: "yaml" };
    case "openclaw": return { path: ["mcp", "servers"], format: "json5" };
  }
}
/** The style an OpenCode file's servers are read with: `opencode-v2` when they sit under `mcp.servers`, else OpenCode 1's `mcp.<name>`. */
export function opencodeMcpStyle(value: unknown): "opencode" | "opencode-v2" { return opencodeMcpServers(value)?.dialect === "v2" ? "opencode-v2" : "opencode"; }
/** DeepSeek Harness's MCP client rows in a patch list: the patch's index, the row's id and its `config`. */
const DSH_CLIENT = "@deepseek-ai/dsh-mcp-client", DSH_PREFIX = "harnesshub-mcp-";
export function dshRows(value: unknown): readonly { readonly index: number; readonly id: string | null; readonly config: Readonly<Record<string, unknown>> }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((patch, index) => (Array.isArray(record(patch).insert) ? record(patch).insert as unknown[] : []).flatMap(row => {
    const item = record(row);
    return item.name === DSH_CLIENT ? [{ index, id: typeof item.id === "string" ? item.id : null, config: record(item.config) }] : [];
  }));
}
/** The entry of server `name` in a parsed file, or undefined. */
export function mcpEntry(value: unknown, style: McpStyle, name: string): unknown {
  // DeepSeek Harness: the config of the client row serving `name`, whoever wrote it.
  if (style === "dsh") return dshRows(value).find(row => row.config.serverName === name)?.config;
  let current: unknown = value;
  for (const key of [...mcpLocation(style).path, name]) { const map = record(current); if (!Object.hasOwn(map, key)) return undefined; current = map[key]; }
  return current;
}

/**
 * The file with server `name` set to `owned` (its owned keys; the entry's other keys stay) or removed (`owned` undefined).
 * Throws UnsafeEdit when the file cannot be changed safely; the result is checked before it is returned.
 */
export function editMcp(text: string, style: McpStyle, name: string, owned: Readonly<Record<string, unknown>> | undefined): string {
  const { path, format } = mcpLocation(style), before = parsed(text, format), current = mcpEntry(before, style, name);
  let after: string;
  // openclaw.json is JSON5; it is edited in place only when it is also plain JSON (or JSONC), as OpenClaw writes it itself. A file that uses JSON5's own
  // syntax (unquoted keys, single quotes) is not rewritten; `openclaw mcp set` writes it then.
  if (style === "openclaw" && !parseConfig(text.trim() === "" ? "{}" : text, "jsonc").ok) throw new UnsafeEdit("openclaw.json 用了 JSON5 独有的写法，HarnessHub 不改写它；可以用 openclaw mcp set 写入");
  if (style === "dsh") after = setDshPatch(text, name, owned);
  else if (format === "jsonc" || style === "openclaw") {
    if (owned === undefined || current === undefined) {
      after = setJson(text, [...path, name], owned === undefined ? undefined : { ...owned });
      // OpenCode 2 keeps its servers two levels down: an `mcp` left with nothing once the last server goes (its emptied `servers` map went with setJson) goes too, so the file returns byte for byte.
      if ((style === "opencode-v2" || style === "openclaw") && owned === undefined) { const left = at(parsed(after, format), ["mcp"]); if (left !== null && typeof left === "object" && !Array.isArray(left) && Object.keys(left).length === 0) after = setJson(after, ["mcp"], undefined); }
    } else {
      after = text;
      const entry = record(current);
      for (const key of MCP_OWNED[style]) {
        const next = owned[key];
        if (next === undefined ? Object.hasOwn(entry, key) : !isDeepStrictEqual(entry[key], next)) after = setJson(after, [...path, name, key], next);
      }
    }
  } else if (format === "yaml") after = setYamlEntry(text, path[0]!, name, owned === undefined ? undefined : merged(record(current), owned, style));
  else after = setTomlServer(text, name, owned);
  const problem = mcpGuard(before, parsed(after, format), style, name, owned);
  if (problem !== null) throw new UnsafeEdit(problem);
  return after;
}
/**
 * The guard every MCP edit passes, before writing and on reading back: nothing outside the entry changed, its owned keys
 * are what was asked (or it is gone), and the keys the user added to it stay. Returns why not, or null.
 */
export function mcpGuard(before: unknown, after: unknown, style: McpStyle, name: string, owned: Readonly<Record<string, unknown>> | undefined): string | null {
  if (style === "dsh") {
    // The patch list is the same but for HarnessHub's own row of this server.
    const ours = (value: unknown) => (Array.isArray(value) ? value : []).filter(patch => !(Array.isArray(record(patch).insert) && (record(patch).insert as unknown[]).some(row => record(row).id === DSH_PREFIX + name)));
    if (!isDeepStrictEqual(JSON.parse(JSON.stringify(ours(before))), JSON.parse(JSON.stringify(ours(after))))) return "改动会超出这个服务器";
    const written = mcpEntry(after, style, name);
    return (owned === undefined ? written !== undefined : !isDeepStrictEqual(ownedOf(written, style), ownedOf(owned, style))) ? "服务器没有改成预期的样子" : null;
  }
  const path = mcpLocation(style).path, current = mcpEntry(before, style, name), written = mcpEntry(after, style, name);
  if (!isDeepStrictEqual(withoutEntry(before, path, name), withoutEntry(after, path, name))) return "改动会超出这个服务器";
  if (owned === undefined ? written !== undefined : !isDeepStrictEqual(ownedOf(written, style), ownedOf(owned, style))) return "服务器没有改成预期的样子";
  if (owned !== undefined && current !== undefined && !isDeepStrictEqual(notOwned(written, style), notOwned(current, style))) return "改动碰到了你自己加的设置";
  return null;
}
function merged(current: Readonly<Record<string, unknown>>, owned: Readonly<Record<string, unknown>>, style: McpStyle): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) if (!MCP_OWNED[style].includes(key)) out[key] = value;
  return { ...owned, ...out };
}
function notOwned(entry: unknown, style: McpStyle): unknown { return Object.fromEntries(Object.entries(record(entry)).filter(([key]) => !MCP_OWNED[style].includes(key))); }
function withoutEntry(value: unknown, path: readonly string[], name: string): unknown {
  const copy = structuredClone(value ?? {}) as Record<string, unknown>, chain: Record<string, unknown>[] = [copy];
  let node: Record<string, unknown> = copy;
  for (const key of path) { const next = node[key]; if (next === null || typeof next !== "object" || Array.isArray(next)) return JSON.parse(JSON.stringify(copy)); node = next as Record<string, unknown>; chain.push(node); }
  delete node[name];
  // An empty map and an absent one mean the same: no servers; so does a container (OpenCode 2's `mcp`) holding nothing but one.
  for (let depth = path.length; depth >= 1 && Object.keys(chain[depth]!).length === 0; depth--) delete chain[depth - 1]![path[depth - 1]!];
  return JSON.parse(JSON.stringify(copy));
}

// ---- YAML (Hermes) ----
function lineStart(text: string, offset: number): number { return text.lastIndexOf("\n", offset - 1) + 1; }
function lineEnd(text: string, offset: number): number { const newline = text.indexOf("\n", offset); return newline < 0 ? text.length : newline; }
function yamlKey(name: string): string { return /^[A-Za-z][A-Za-z0-9_-]*$/u.test(name) ? name : JSON.stringify(name); }
function block(name: string, value: Readonly<Record<string, unknown>>, indent: string, eol: string): string {
  const body = stringify(value, { indent: 2, lineWidth: 0 }).replace(/\n$/u, "").split("\n").map(line => indent + "  " + line).join(eol);
  return indent + yamlKey(name) + ":" + eol + body + eol;
}
/** YAML: sets or removes `parent.name` (a block map entry) by splicing whole lines; a flow-style map is not changed. */
export function setYamlEntry(text: string, parent: string, name: string, value: Readonly<Record<string, unknown>> | undefined): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n", document = parseDocument(text, { uniqueKeys: false });
  if (document.errors.length) throw new UnsafeEdit("YAML 无法解析");
  const root = document.contents;
  if (root !== null && !(isMap(root) && !root.flow)) throw new UnsafeEdit("配置文件的顶层不是普通的映射");
  const pair = root?.items.find(item => isScalar(item.key) && item.key.value === parent);
  if (pair === undefined) {
    if (value === undefined) return text;
    const prefix = text === "" || text.endsWith("\n") ? text : text + eol;
    return prefix + parent + ":" + eol + block(name, value, "  ", eol);
  }
  const keyStart = isScalar(pair.key) && pair.key.range ? pair.key.range[0] : null;
  if (keyStart === null) throw new UnsafeEdit("YAML 的写法无法定位");
  const map = pair.value;
  if (map === null || (isScalar(map) && map.value === null) || (isMap(map) && map.flow && map.items.length === 0)) {
    if (value === undefined) return text;
    // `parent:` or `parent: {}`: the empty value becomes a block with this one entry.
    const keyLineEnd = lineEnd(text, keyStart), head = text.slice(lineStart(text, keyStart), keyLineEnd).replace(/:\s*(\{\s*\}|null|~)?\s*(#.*)?$/u, ":$2");
    const indent = /^\s*/u.exec(text.slice(lineStart(text, keyStart), keyLineEnd))![0];
    return text.slice(0, lineStart(text, keyStart)) + head + eol + block(name, value, indent + "  ", eol) + text.slice(Math.min(text.length, keyLineEnd + (text.slice(keyLineEnd, keyLineEnd + 2) === "\r\n" ? 2 : 1)));
  }
  if (!isMap(map) || map.flow) throw new UnsafeEdit(parent + " 用的是单行写法，HarnessHub 不改");
  const first = map.items[0], firstStart = first && isScalar(first.key) && first.key.range ? first.key.range[0] : null;
  const indent = firstStart === null ? /^\s*/u.exec(text.slice(lineStart(text, keyStart)))![0] + "  " : text.slice(lineStart(text, firstStart), firstStart);
  const index = map.items.findIndex(item => isScalar(item.key) && item.key.value === name);
  const end = (item: (typeof map.items)[number]): number => {
    const node = item.value as { range?: [number, number, number] } | null, keyRange = (item.key as { range?: [number, number, number] }).range;
    const last = node?.range ? node.range[1] : keyRange ? keyRange[1] : null;
    if (last === null) throw new UnsafeEdit("YAML 的写法无法定位");
    // A block value's range runs over the blank lines after it; the entry ends at its last line with content.
    let stop = last; while (stop > 0 && /\s/u.test(text[stop - 1]!)) stop--;
    const close = lineEnd(text, stop);
    return close < text.length ? close + 1 : close;
  };
  if (index >= 0) {
    const item = map.items[index]!, start = lineStart(text, (item.key as { range: [number, number, number] }).range[0]), stop = end(item);
    if (value !== undefined) return text.slice(0, start) + block(name, value, indent, eol) + text.slice(stop);
    if (map.items.length === 1) {
      // The last entry goes: the map is written back as `{}`, so it still parses as an empty map.
      const keyLine = lineStart(text, keyStart), keyLineEnd = lineEnd(text, keyStart);
      return text.slice(0, keyLine) + text.slice(keyLine, keyLineEnd).replace(/:\s*(#.*)?$/u, ": {}") + eol + text.slice(stop);
    }
    return text.slice(0, start) + text.slice(stop);
  }
  if (value === undefined) return text;
  const stop = end(map.items.at(-1)!), insert = stop === text.length && !text.endsWith("\n") ? eol + block(name, value, indent, eol) : block(name, value, indent, eol);
  return text.slice(0, stop) + insert + text.slice(stop);
}

// ---- TOML (Codex) ----
interface Line { readonly start: number; readonly end: number; readonly text: string }
function lines(text: string): Line[] {
  const out: Line[] = []; let start = 0;
  while (start < text.length) { const newline = text.indexOf("\n", start), end = newline < 0 ? text.length : newline; out.push({ start, end, text: text.slice(start, end).replace(/\r$/u, "") }); start = end + 1; }
  return out;
}
/** A table header's dotted key with spaces and simple quotes removed, or null for a line that is not a header. */
function header(line: string): { readonly key: string; readonly array: boolean } | null {
  const match = /^\s*(\[\[?)\s*([^\]#]+?)\s*\]\]?\s*(?:#.*)?$/u.exec(line);
  return match ? { key: match[2]!.split(".").map(part => part.trim().replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1")).join("."), array: match[1] === "[[" } : null;
}
function tomlString(value: string): string { return "\"" + value.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"").replace(/\n/gu, "\\n").replace(/\r/gu, "\\r").replace(/\t/gu, "\\t") + "\""; }
function tomlKey(key: string): string { return /^[A-Za-z0-9_-]+$/u.test(key) ? key : tomlString(key); }
function tomlValue(value: unknown): string {
  if (typeof value === "string") return tomlString(value);
  if (Array.isArray(value)) return "[" + value.map(tomlValue).join(", ") + "]";
  if (value !== null && typeof value === "object") return "{ " + Object.entries(value).map(([key, item]) => tomlKey(key) + " = " + tomlValue(item)).join(", ") + " }";
  throw new UnsafeEdit("这个值无法写成 TOML");
}
/**
 * The lines of the table group `[mcp_servers.<name>]` and its sub-tables: where it starts and ends, the main table's key
 * lines by key, and each sub-table, found outside multi-line strings. A key whose value spans lines makes `multiline` true.
 */
function tomlGroup(text: string, name: string) {
  const own = "mcp_servers." + name;
  let quote: string | null = null, inGroup = false, main = false, start = -1, end = -1, multiline = false, pending: { key: string; start: number } | null = null, depth = 0;
  const keys = new Map<string, { start: number; end: number }>(), tables: { key: string; start: number; end: number }[] = [];
  let mainHeader = -1;
  for (const line of lines(text)) {
    if (quote !== null) { if (line.text.split(quote).length % 2 === 0) quote = null; if (inGroup) end = line.end; continue; }
    if (pending !== null) {
      depth += (line.text.match(/[[{]/gu)?.length ?? 0) - (line.text.match(/[\]}]/gu)?.length ?? 0); end = line.end;
      if (depth <= 0) { keys.set(pending.key, { start: pending.start, end: line.end }); pending = null; }
      continue;
    }
    const found = header(line.text);
    if (found) {
      inGroup = !found.array && (found.key === own || found.key.startsWith(own + "."));
      main = inGroup && found.key === own;
      if (inGroup) { if (start < 0) start = line.start; end = line.end; if (main) mainHeader = line.end; else tables.push({ key: found.key.slice(own.length + 1), start: line.start, end: line.end }); }
      continue;
    }
    if (!inGroup) continue;
    if (/^\s*(#.*)?$/u.test(line.text)) continue;
    end = line.end;
    if (!main) { tables.at(-1)!.end = line.end; }
    const pair = /^\s*([A-Za-z0-9_-]+|"[^"]+"|'[^']+')\s*=\s*(.*)$/u.exec(line.text);
    if (main && pair) {
      const key = pair[1]!.replace(/^["'](.*)["']$/u, "$1"), rest = pair[2]!.replace(/\s+#.*$/u, "");
      const open = (rest.match(/[[{]/gu)?.length ?? 0) - (rest.match(/[\]}]/gu)?.length ?? 0);
      if (open > 0) { multiline = true; pending = { key, start: line.start }; depth = open; continue; }
      keys.set(key, { start: line.start, end: line.end });
    }
    const opening = /"""|'''/u.exec(line.text)?.[0] ?? null;
    if (opening !== null && line.text.split(opening).length % 2 === 0) { quote = opening; multiline = true; }
  }
  return start < 0 ? null : { start, end, mainHeader, keys, tables, multiline };
}
function cut(text: string, start: number, end: number): string {
  const stop = end < text.length && text[end] === "\n" ? end + 1 : end;
  return text.slice(0, start) + text.slice(stop);
}
/** Codex: adds, changes (owned keys only) or removes the table group of server `name`. */
export function setTomlServer(text: string, name: string, owned: Readonly<Record<string, unknown>> | undefined): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n", group = tomlGroup(text, name), ownedKeys = MCP_OWNED.codex;
  const body = (value: Readonly<Record<string, unknown>>) => Object.entries(value).map(([key, item]) => tomlKey(key) + " = " + tomlValue(item)).join(eol);
  if (group === null) {
    if (owned === undefined) return text;
    const prefix = text === "" ? "" : text.endsWith("\n") ? text + eol : text + eol + eol;
    return prefix + "[mcp_servers." + tomlKey(name) + "]" + eol + body(owned) + eol;
  }
  if (owned === undefined) {
    // The whole group goes, with the blank line before it, or else the one after it.
    let start = group.start, end = group.end;
    if (start >= 2 && text.slice(start - 2, start) === "\n\n") start -= 1;
    else if (start >= 4 && text.slice(start - 4, start) === "\r\n\r\n") start -= 2;
    else if (text.slice(end, end + 2) === "\n\n") end += 1;
    else if (text.slice(end - 1, end + 3) === "\r\n\r\n") end += 2;
    return cut(text, start, end);
  }
  if (group.mainHeader < 0) throw new UnsafeEdit("这个服务器只有子表，没有主表");
  if (group.multiline) throw new UnsafeEdit("这个服务器有跨多行的写法，HarnessHub 不改");
  if (group.tables.some(table => table.start < group.mainHeader)) throw new UnsafeEdit("这个服务器的子表写在主表前面，HarnessHub 不改");
  // Owned keys come out of the main table (and owned sub-tables go); the new ones go in right after the header.
  const ranges = [...[...group.keys].filter(([key]) => ownedKeys.includes(key)).map(([, range]) => range), ...group.tables.filter(table => ownedKeys.includes(table.key)).map(table => ({ start: table.start, end: table.end }))]
    .sort((left, right) => right.start - left.start);
  let next = text;
  for (const range of ranges) next = cut(next, range.start, range.end);
  const at = group.mainHeader + (next[group.mainHeader] === "\n" ? 1 : 0);
  return next.slice(0, at) + body(owned) + eol + next.slice(at);
}

// ---- YAML patch list (DeepSeek Harness) ----
/** A config with `!!js` expressions as DeepSeek Harness reads them, as YAML text (expressions always double-quoted). */
function dshConfig(config: Readonly<Record<string, unknown>>, indent: string, eol: string): string {
  const expressions: string[] = [];
  const plain = JSON.parse(JSON.stringify(config, (_, value: unknown) => value !== null && typeof value === "object" && typeof (value as { jsExpression?: unknown }).jsExpression === "string"
    ? "__HARNESSHUB_JS_" + (expressions.push((value as { jsExpression: string }).jsExpression) - 1) + "__" : value)) as Record<string, unknown>;
  return stringify(plain, { indent: 2, lineWidth: 0 }).replace(/\n$/u, "").replace(/__HARNESSHUB_JS_(\d+)__/gu, (_, index: string) => "!!js " + JSON.stringify(expressions[Number(index)]))
    .split("\n").map(line => indent + line).join(eol);
}
/** One patch of the list: an insert of HarnessHub's own MCP client row for `name`. */
function dshPatch(name: string, config: Readonly<Record<string, unknown>>, eol: string): string {
  return "- insert:" + eol + "    - id: " + DSH_PREFIX + name + eol + "      name: \"" + DSH_CLIENT + "\"" + eol + "      config:" + eol + dshConfig(config, "        ", eol) + eol;
}
/**
 * DeepSeek Harness's user patch layer (a top-level YAML array): HarnessHub's own insert of server `name` added, replaced
 * or removed by whole lines. The list is never left empty or absent once it was there: an empty one is written as `[]`,
 * since DeepSeek Harness refuses to start on a patch file that is not an array.
 */
export function setDshPatch(text: string, name: string, config: Readonly<Record<string, unknown>> | undefined): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n", document = parseDocument(text, { uniqueKeys: false, customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }] });
  if (document.errors.length) throw new UnsafeEdit("补丁文件无法解析");
  const root = document.contents;
  if (root !== null && !isSeq(root)) throw new UnsafeEdit("补丁文件的顶层不是列表");
  const items = root === null ? [] : root.items, index = items.findIndex(item => {
    const insert = isMap(item) ? item.get("insert", true) : null;
    return isSeq(insert) && insert.items.some(row => isMap(row) && row.get("id") === DSH_PREFIX + name);
  });
  const block = config === undefined ? "" : dshPatch(name, { serverName: name, ...config }, eol);
  if (root === null || (root.flow && items.length === 0)) {
    if (config === undefined) return text;
    // An empty list (`[]`, or a file of comments only) becomes a block list holding this patch.
    if (root === null) return (text === "" || text.endsWith("\n") ? text : text + eol) + block;
    const [start, end] = root.range!;
    return text.slice(0, start) + block.replace(new RegExp(eol + "$", "u"), "") + text.slice(end);
  }
  if (root.flow) throw new UnsafeEdit("补丁列表用的是单行写法，HarnessHub 不改");
  const range = (item: unknown): { start: number; end: number } => {
    const node = item as { range?: [number, number, number] };
    if (!node.range) throw new UnsafeEdit("补丁的写法无法定位");
    let stop = node.range[1]; while (stop > 0 && /\s/u.test(text[stop - 1]!)) stop--;
    const close = lineEnd(text, stop), dash = text.lastIndexOf("-", node.range[0]);
    return { start: lineStart(text, dash < 0 ? node.range[0] : dash), end: close < text.length ? close + 1 : close };
  };
  if (index >= 0) {
    const { start, end } = range(items[index]);
    if (config !== undefined) return text.slice(0, start) + block + text.slice(end);
    if (items.length === 1) return text.slice(0, start) + "[]" + eol + text.slice(end);
    return text.slice(0, start) + text.slice(end);
  }
  if (config === undefined) return text;
  const { end } = range(items.at(-1));
  return text.slice(0, end) + (end === text.length && !text.endsWith("\n") ? eol : "") + block + text.slice(end);
}

