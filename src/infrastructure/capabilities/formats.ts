import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml, type ScalarTag } from "yaml";
import JSON5 from "json5";

/** A configuration file's content as parsed, or why it could not be: nothing is guessed from a file that does not parse. */
export type Parsed = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string };
/** `markdown`: an instructions file, taken as its text (HarnessHub reads only its own block in it). */
export type ConfigFormat = "json" | "jsonc" | "json5" | "toml" | "yaml" | "markdown";

/** DeepSeek Harness writes `!!js process.env.NAME`; read it as a reference, never evaluated. */
const jsTag: ScalarTag = { tag: "tag:yaml.org,2002:js", resolve: (text: string) => ({ jsExpression: text }) };

/** Parses configuration text by format: JSON and JSONC tolerate comments and trailing commas, as the Harnesses that write them do. */
export function parseConfig(text: string, format: ConfigFormat): Parsed {
  try {
    switch (format) {
      case "json": case "jsonc": {
        const errors: ParseError[] = [], value: unknown = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
        return errors.length ? { ok: false, reason: "不是有效的 JSON（第 " + (errors[0]!.offset) + " 个字符附近）" } : { ok: true, value };
      }
      case "json5": return { ok: true, value: JSON5.parse(text) as unknown };
      case "toml": return { ok: true, value: parseToml(text) as unknown };
      case "yaml": return { ok: true, value: parseYaml(text, { customTags: [jsTag], prettyErrors: false, uniqueKeys: false }) as unknown };
      case "markdown": return { ok: true, value: text };
    }
  } catch (error) {
    return { ok: false, reason: "无法解析（" + (error instanceof Error ? error.name : "未知错误") + "）" };
  }
}
/**
 * The frontmatter of a SKILL.md, subagent or command file: the YAML between a leading `---` line and the next one.
 * `found` is false when the file has none; `value` is null when it does not parse.
 */
export function frontmatter(text: string): { readonly found: boolean; readonly value: Readonly<Record<string, unknown>> | null } {
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text);
  if (!match) return { found: false, value: null };
  const parsed = parseConfig(match[1]!, "yaml");
  return { found: true, value: parsed.ok && parsed.value !== null && typeof parsed.value === "object" && !Array.isArray(parsed.value) ? parsed.value as Record<string, unknown> : null };
}
/** A plain object's own entries; anything else is treated as empty. */
export function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** The value at a key path of nested plain objects; undefined when any step is missing. */
export function at(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) { if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, key)) return undefined; current = (current as Record<string, unknown>)[key]; }
  return current;
}
export function text(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
