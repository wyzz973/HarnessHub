import type { PublicRun, PublicTool, RunStatus } from "../../../src/contracts/session.js";
import { toolParents } from "../tool-tree.js";

export type Tool = PublicTool;
export const TOOL_PENDING = new Set(["pending", "in_progress", "inProgress", "running"]);
export const TOOL_STATUS: Readonly<Record<string, string>> = { pending: "等待", in_progress: "执行中", inProgress: "执行中", running: "执行中", completed: "完成", failed: "失败", declined: "已拒绝", cancelled: "已取消", interrupted: "已中断" };
export function finished(status: RunStatus): boolean { return status === "completed" || status === "cancelled" || status === "failed" || status === "unknown"; }
export function toolFailed(tool: Pick<Tool, "status">): boolean { return tool.status === "failed" || tool.status === "declined"; }
/** Once the Turn has ended, a tool whose end was never reported did not finish as far as anyone can tell. */
export function toolUnfinished(tool: Pick<Tool, "status">, active: boolean): boolean { return !active && TOOL_PENDING.has(tool.status); }

type Category = "read" | "search" | "execute" | "edit" | "fetch" | "mcp" | "agent" | "other";
function category(tool: Tool, nested: boolean): Category {
  if (nested) return "agent";
  switch (tool.kind) {
    case "read": return "read";
    case "search": return "search";
    case "execute": return "execute";
    case "edit": case "delete": case "move": return "edit";
    case "fetch": return "fetch";
    case "mcp": return "mcp";
    case "subagent": return "agent";
    default: return "other";
  }
}
const PHRASES: Readonly<Record<Category, (n: number) => string>> = {
  read: n => `读取 ${n} 个文件`, search: n => `搜索 ${n} 次`, execute: n => `执行 ${n} 条命令`, edit: n => `改动 ${n} 个文件`,
  fetch: n => `访问 ${n} 个网页`, mcp: n => `调用 ${n} 个 MCP 工具`, agent: n => `子 Agent ${n} 个`, other: n => `其他工具 ${n} 个`,
};
export interface ToolTree { readonly roots: readonly Tool[]; readonly children: ReadonlyMap<string, readonly Tool[]> }
/** Tools in call order; a tool whose parent call is listed is shown under it, as the sub-agent work of that call. */
export function toolTree(tools: readonly Tool[]): ToolTree {
  const parents = toolParents(tools), children = new Map<string, Tool[]>();
  for (const tool of tools) { const parent = parents.get(tool.id); if (parent !== undefined) children.set(parent, [...(children.get(parent) ?? []), tool]); }
  return { roots: tools.filter(tool => !parents.has(tool.id)), children };
}
/**
 * One line for a Turn's tools, such as "读取 2 个文件，执行 1 条命令". Failed and unfinished tools are always counted in it
 * (the approver's condition for folding the process): folding never hides them.
 */
export function toolSummary(tools: readonly Tool[], active: boolean): { readonly text: string; readonly failed: number; readonly unfinished: number; readonly running: Tool | null } {
  const { roots, children } = toolTree(tools), counts = new Map<Category, number>();
  for (const tool of roots) { const kind = category(tool, (children.get(tool.id)?.length ?? 0) > 0); counts.set(kind, (counts.get(kind) ?? 0) + 1); }
  const order: Category[] = ["read", "search", "execute", "edit", "fetch", "mcp", "agent", "other"];
  const parts = order.filter(kind => counts.has(kind)).map(kind => PHRASES[kind](counts.get(kind)!));
  const failed = tools.filter(toolFailed).length, unfinished = tools.filter(tool => toolUnfinished(tool, active)).length;
  if (failed) parts.push(`${failed} 项失败`);
  if (unfinished) parts.push(`${unfinished} 项未完成`);
  const running = active ? [...tools].reverse().find(tool => TOOL_PENDING.has(tool.status)) ?? null : null;
  return { text: parts.join("，"), failed, unfinished, running };
}

export interface DiffLine { readonly kind: "add" | "remove" | "context" | "hunk" | "file" | "meta"; readonly text: string; readonly oldNo?: number; readonly newNo?: number }
export interface DiffFile { readonly path: string; readonly add: number; readonly del: number; readonly lines: readonly DiffLine[] }
function stripPrefix(path: string): string { return path.replace(/^[ab]\//u, "").replace(/\t.*$/u, ""); }
/**
 * Splits unified diff text into files with numbered lines. Text without file headers becomes one file named `fallback`.
 * Counting is display data only; the text itself is shown exactly as the program reported it.
 */
export function parseUnifiedDiff(text: string, fallback: string): readonly DiffFile[] {
  interface Draft { path: string; add: number; del: number; lines: DiffLine[] }
  const files: Draft[] = [];
  let oldNo = 0, newNo = 0;
  const open = (path: string): Draft => { const file: Draft = { path, add: 0, del: 0, lines: [] }; files.push(file); return file; };
  const lines = text.replace(/\n$/u, "").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!, last = files.at(-1);
    if (line.startsWith("diff --git ")) { const match = / b\/(.+)$/u.exec(line); open(match ? match[1]! : fallback).lines.push({ kind: "file", text: line }); continue; }
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      const next = lines[index + 1]!, target = stripPrefix(next.slice(4)), source = stripPrefix(line.slice(4));
      const path = target === "/dev/null" ? source : target;
      // A "diff --git" header already opened this file; its ---/+++ lines name it more exactly.
      const file = last !== undefined && last.lines.every(row => row.kind === "file" || row.kind === "meta") ? last : open(path);
      file.path = path; file.lines.push({ kind: "file", text: line }, { kind: "file", text: next }); index++; continue;
    }
    const file = last ?? open(fallback);
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk) { oldNo = Number(hunk[1]); newNo = Number(hunk[2]); file.lines.push({ kind: "hunk", text: line }); continue; }
    if (line.startsWith("+")) { file.add++; file.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ }); continue; }
    if (line.startsWith("-")) { file.del++; file.lines.push({ kind: "remove", text: line.slice(1), oldNo: oldNo++ }); continue; }
    if (line.startsWith("\\")) { file.lines.push({ kind: "meta", text: line }); continue; }
    if (/^(index |new file mode|deleted file mode|similarity index|rename from|rename to|old mode|new mode)/u.test(line)) { file.lines.push({ kind: "meta", text: line }); continue; }
    file.lines.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ });
  }
  return files;
}
/** Tools of a Turn that edited files and carry stored detail, in call order. */
export function editTools(run: Pick<PublicRun, "tools">): readonly Tool[] {
  return (run.tools ?? []).filter(tool => (tool.kind === "edit" || tool.kind === "delete" || tool.kind === "move") && tool.detail !== undefined);
}
