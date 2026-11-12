import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { frontmatter, parseConfig, record, text } from "./formats.js";
import { userTextProblem } from "./instruction-blocks.js";

/**
 * A subagent as HarnessHub's list keeps it (ADR-045 §7, step 5): only what every Harness keeps alike, its description
 * and its prompt. No tools, model, permissions, hooks or MCP servers are written: a subagent works with its parent
 * session's model, tools and permissions, and HarnessHub never writes what could widen them or start a program.
 */
export interface SubagentDefinition { readonly description: string; readonly prompt: string }
/** The Harnesses whose user-level subagent files HarnessHub writes, each in its own format. */
export type SubagentStyle = "claude" | "codex" | "gemini" | "opencode";
export const SUBAGENT_NAME = /^[a-z][a-z0-9-]{0,63}$/u;
/** The most a prompt may hold, in UTF-8 bytes. */
export const SUBAGENT_PROMPT_BYTES = 8 * 1024 * 1024;
/** Gemini fills `${…}` in a subagent's prompt and fails on a name it does not know. */
const GEMINI_TEMPLATE = /\$\{/u;

/**
 * Why a subagent cannot be listed, or null: its name (a built-in's of any of the four Harnesses, in `reserved` with that
 * Harness's name, is refused: a user-level subagent of that name would replace the built-in or be ignored), its
 * description (one line) or its prompt (it must not begin with a `---` line, which would read as a second frontmatter).
 * The texts are checked as stored: trimmed, line breaks LF.
 */
export function subagentProblem(name: string, definition: SubagentDefinition, homes: readonly string[], reserved: ReadonlyMap<string, string>): string | null {
  if (!SUBAGENT_NAME.test(name)) return "名字只能用小写字母、数字和 -，以字母开头，最多 64 个字符";
  const builtIn = reserved.get(name);
  if (builtIn !== undefined) return "“" + name + "”是 " + builtIn + " 的内置子 Agent，同名的会顶替它或被它挡住";
  const { description, prompt } = canonicalSubagent(definition);
  if (description === "") return "要写说明：Harness 按说明决定什么时候交给这个子 Agent";
  if (/[\r\n]/u.test(description) || description.length > 1024) return "说明只能是一行，最多 1024 个字符";
  const descriptionProblem = userTextProblem(description, homes);
  if (descriptionProblem !== null) return "说明" + descriptionProblem;
  if (prompt === "") return "要写正文：这是子 Agent 的系统提示";
  if (Buffer.byteLength(prompt, "utf8") > SUBAGENT_PROMPT_BYTES) return "正文最多 8 MiB";
  if (/^---[ \t]*(?:\n|$)/u.test(prompt)) return "正文不能以 --- 行开头，否则会被当成第二段 frontmatter";
  const promptProblem = userTextProblem(prompt, homes);
  return promptProblem === null ? null : "正文" + promptProblem;
}
/** The definition as stored and written: both texts trimmed (Codex and Gemini trim what they read), the prompt's line breaks LF. */
export function canonicalSubagent(definition: SubagentDefinition): SubagentDefinition {
  return { description: definition.description.trim(), prompt: definition.prompt.replace(/\r\n/gu, "\n").trim() };
}

/** Where a Harness keeps a user-level subagent HarnessHub writes, under its configuration directory. */
export function subagentFile(directory: string, name: string, style: SubagentStyle): string { return join(directory, name + (style === "codex" ? ".toml" : ".md")); }
/** Why a Harness cannot take this subagent, or null: Gemini fills `${…}` in a prompt. */
export function subagentStyleProblem(definition: SubagentDefinition, style: SubagentStyle): string | null {
  return style === "gemini" && GEMINI_TEMPLATE.test(definition.prompt) ? "Gemini 会把正文里的 ${…} 当作模板变量，只认 query、cliVersion、activeModel、today，别的名字会让调用失败" : null;
}
/** A string as YAML reads it back unchanged: double-quoted with JSON's escapes, which YAML shares. */
function yamlString(value: string): string { return JSON.stringify(value); }
/** TOML text for a prompt: a multi-line basic string, every backslash and quote escaped (so neither a closing """ nor a line continuation can occur). */
function tomlText(value: string): string { return '"""\n' + value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"') + '"""'; }

/**
 * The whole file HarnessHub writes for a subagent in a Harness, in that Harness's own format with only the keys it
 * requires: Claude Code and Gemini a frontmatter of `name` and `description`; OpenCode `description` and `mode:
 * subagent` (its name is the file's); Codex `name`, `description` and `developer_instructions`.
 */
export function renderSubagent(name: string, definition: SubagentDefinition, style: SubagentStyle): string {
  const { description, prompt } = canonicalSubagent(definition);
  switch (style) {
    case "claude": case "gemini": return "---\nname: " + name + "\ndescription: " + yamlString(description) + "\n---\n\n" + prompt + "\n";
    case "opencode": return "---\ndescription: " + yamlString(description) + "\nmode: subagent\n---\n\n" + prompt + "\n";
    case "codex": return "name = " + JSON.stringify(name) + "\ndescription = " + JSON.stringify(description) + "\ndeveloper_instructions = " + tomlText(prompt) + "\n";
  }
}
/**
 * A subagent file read the way its Harness reads it: its name (OpenCode's from the path), description and prompt, and
 * the keys it holds; null when it does not parse as one. Used to check what was written and to find same-named ones.
 */
export function readSubagent(fileText: string, style: SubagentStyle, pathName: string | null): { readonly name: string | null; readonly description: string | null; readonly prompt: string; readonly keys: readonly string[] } | null {
  if (style === "codex") {
    const parsed = parseConfig(fileText, "toml");
    if (!parsed.ok) return null;
    const value = record(parsed.value), instructions = text(value.developer_instructions) ?? "";
    return { name: text(value.name), description: text(value.description), prompt: instructions, keys: Object.keys(value).sort() };
  }
  const head = frontmatter(fileText);
  if (!head.found || head.value === null) return null;
  const body = fileText.replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u, "").replace(/^\r?\n/u, "").replace(/\s+$/u, "");
  const name = style === "opencode" ? text(head.value.name) ?? pathName : text(head.value.name);
  return { name, description: text(head.value.description), prompt: body, keys: Object.keys(head.value).sort() };
}

/** The subagent files of a Harness's user-level directory, as it finds them: Codex, Claude and OpenCode recursively, Gemini only regular files at the top. */
function subagentFiles(directory: string, style: SubagentStyle): readonly { readonly path: string; readonly pathName: string }[] {
  const out: { path: string; pathName: string }[] = [], suffix = style === "codex" ? ".toml" : ".md";
  const walk = (dir: string, level: number) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (style === "gemini" && (level > 0 || !entry.isFile() || entry.name.startsWith("_"))) continue;
      if (entry.isDirectory()) { if (level < 8) walk(path, level + 1); continue; }
      if (!entry.name.endsWith(suffix) || entry.name.startsWith(".")) continue;
      let file = false; try { file = lstatSync(path).isFile(); } catch { file = false; }
      if (style === "gemini" && !file) continue;
      out.push({ path, pathName: relative(directory, path).slice(0, -suffix.length).split(sep).join("/") });
    }
  };
  walk(directory, 0);
  return out;
}
/** Other files in a Harness's directory that define a subagent of this name, by that Harness's naming: these are never overwritten. */
export function sameNamedSubagents(directory: string, name: string, style: SubagentStyle, except: string): readonly string[] {
  return subagentFiles(directory, style).filter(file => {
    if (file.path === except) return false;
    let content: string; try { content = readFileSync(file.path, "utf8"); } catch { return false; }
    const read = readSubagent(content, style, file.pathName);
    return (read?.name ?? (style === "opencode" ? file.pathName : null)) === name;
  }).map(file => file.path);
}
