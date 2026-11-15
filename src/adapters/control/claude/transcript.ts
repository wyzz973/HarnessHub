import { randomBytes } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_CONTENT_BYTES } from "../../../contracts/content.js";
import { ControlError } from "../../../infrastructure/control/json-rpc-process.js";
import { record, type Row } from "./mapping.js";

/**
 * Claude Code's own record of a session, read only (it keeps `projects/<cwd with every other character a dash>/<session>.jsonl` in its
 * configuration directory): where it is, the chain of its entries (each names its parent; a resume at an entry starts a branch, and the newest
 * entry's chain is the session), and which entries are the Hub's prompts. The driver writes nothing here.
 */

/**
 * The identity of a prompt the Hub sends (`uuid` of the SDK user message, which Claude Code keeps as the transcript entry's own): a UUID of
 * version 8 (RFC 9562's custom version), so that the Hub's prompts are told apart in the transcript from everything else, its own steered words
 * included (those are random version-4 identities, and Claude Code keeps them as attachments). Seen on 2.1.325: the CLI takes it and keeps it.
 */
export function promptId(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}
export const isPromptId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Claude Code's configuration directory for this process's environment. */
export function configDir(env: Readonly<Record<string, string | undefined>>): string { return env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"); }
/** The project directory name Claude Code gives a working directory. */
export function projectName(cwd: string): string { return cwd.replace(/[^A-Za-z0-9]/gu, "-"); }
const MAX_PROJECT_DIRECTORIES = 4096;
/** The transcript of a session: under the working directory's project first, then any project (a session resumed from elsewhere); null when none. */
export async function transcriptPath(env: Readonly<Record<string, string | undefined>>, id: string, cwd?: string): Promise<string | null> {
  if (!SESSION_ID.test(id)) return null;
  const projects = join(configDir(env), "projects");
  const isFile = (path: string) => stat(path).then(info => info.isFile(), () => false);
  if (cwd !== undefined && await isFile(join(projects, projectName(cwd), id + ".jsonl"))) return join(projects, projectName(cwd), id + ".jsonl");
  let entries: string[];
  try { entries = (await readdir(projects)).slice(0, MAX_PROJECT_DIRECTORIES); } catch { return null; }
  for (const entry of entries) { const candidate = join(projects, entry, id + ".jsonl"); if (await isFile(candidate)) return candidate; }
  return null;
}
export interface Entry { readonly uuid: string; readonly parent: string | null; readonly type: string; readonly row: Row }
/** The session's chain: from its newest entry back through each parent, oldest first. */
export async function readChain(path: string): Promise<readonly Entry[]> {
  const info = await stat(path);
  if (info.size > MAX_CONTENT_BYTES) throw new ControlError("NATIVE_SESSION_UNAVAILABLE", "the Claude Code transcript exceeds 1 GiB");
  const byId = new Map<string, Entry>();
  let last: string | null = null;
  for (const raw of (await readFile(path, "utf8")).split("\n")) {
    if (!raw.trim()) continue;
    let row: Row | null;
    try { row = record(JSON.parse(raw)); } catch { continue; }
    if (row === null || typeof row.uuid !== "string" || row.isSidechain === true) continue;
    byId.set(row.uuid, { uuid: row.uuid, parent: typeof row.parentUuid === "string" ? row.parentUuid : null, type: typeof row.type === "string" ? row.type : "", row });
    last = row.uuid;
  }
  const chain: Entry[] = [], seen = new Set<string>();
  for (let at = last; at !== null && !seen.has(at);) { const entry = byId.get(at); if (entry === undefined) break; seen.add(at); chain.push(entry); at = entry.parent; }
  return chain.reverse();
}
/** The Hub's prompts in a chain, oldest first: user entries the Hub sent (isPromptId). */
export function hubPrompts(chain: readonly Entry[]): readonly Entry[] { return chain.filter(entry => entry.type === "user" && isPromptId(entry.uuid) && entry.row.isMeta !== true); }
/**
 * Where a resume keeps the history to, to take off the last `turns` of the Hub's Turns with their answers: the entry right before the earliest
 * prompt dropped (its parent). Refused when the chain holds fewer Turns, or the cut would leave nothing (the first Turn: the Hub's clear does that).
 */
export function cutPoint(chain: readonly Entry[], turns: number): string {
  const prompts = hubPrompts(chain);
  if (!Number.isSafeInteger(turns) || turns < 1) throw new ControlError("INVALID_INPUT", "turns must be a positive integer");
  if (prompts.length < turns) throw new ControlError("NATIVE_ROLLBACK_UNAVAILABLE", "Claude Code 的记录里没有这么多轮（只找到 " + prompts.length + " 轮 HarnessHub 发出的消息）。");
  const parent = prompts[prompts.length - turns]!.parent;
  if (parent === null) throw new ControlError("NATIVE_ROLLBACK_UNAVAILABLE", "回退到第一轮之前就是清空：用清空开一个新会话。");
  return parent;
}
/** A message's text: its string content, or its text blocks joined; tool results and other blocks are not text. */
function messageText(message: unknown): string {
  const row = record(message), content = row?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(part => { const block = record(part); return block?.type === "text" && typeof block.text === "string" ? [block.text] : []; }).join("\n");
}
/** What Claude Code writes as a user entry that the user did not type: command echoes, interruptions, reminders. */
const NOT_TYPED = /^(?:<command-|<local-command-|<system-reminder>|\[Request interrupted)/u;
/**
 * A chain as the user's words and Claude's answers, oldest first: each user entry with text of its own (not a tool's result, not meta, not a
 * command's echo), each answer the text of the assistant entries until the next such user entry.
 */
export function chainHistory(chain: readonly Entry[]): { role: "user" | "assistant"; text: string }[] {
  const out: { role: "user" | "assistant"; text: string }[] = [];
  for (const entry of chain) {
    if (entry.type === "user") {
      const said = messageText(entry.row.message).trim();
      if (!said || entry.row.isMeta === true || entry.row.isCompactSummary === true || NOT_TYPED.test(said)) continue;
      out.push({ role: "user", text: said });
    } else if (entry.type === "assistant") {
      const said = messageText(entry.row.message).trim();
      if (!said) continue;
      const prior = out.at(-1);
      if (prior?.role === "assistant") prior.text += "\n\n" + said; else out.push({ role: "assistant", text: said });
    }
  }
  return out;
}
/** The working directory a transcript was made in, as its first entry that says. */
export function chainCwd(chain: readonly Entry[]): string | null {
  for (const entry of chain) if (typeof entry.row.cwd === "string") return entry.row.cwd;
  return null;
}
