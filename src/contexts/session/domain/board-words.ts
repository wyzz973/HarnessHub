import type { BoardEntry, SessionId } from "../../../contracts/session.js";
import { contextTurnPath } from "./context-paths.js";

/**
 * Who wrote an entry of the task board, as a Harness reads it (2026-11-14). The user's own entries are the user's; one a Harness wrote is that Harness's reading of
 * what the user said, and names the Turn it was written in, so that another Harness can read the user's actual words there. `files`: the reader reads the record as
 * files — the Turn is then named by its path, relative to the task's record directory; otherwise by its conversation's label and its number, which the Hub's tools read.
 */
export const conversationLabel = (id: SessionId): string => "c-" + id.replace(/^session-/u, "").replace(/-/gu, "").slice(0, 6);
export function boardAuthor(entry: BoardEntry, name: (harnessId: string) => string, files: boolean): string {
  if (entry.by === "user") return "用户写的";
  const who = name(entry.by) + " 记的";
  if (entry.from === undefined) return who;
  const label = conversationLabel(entry.from.sessionId), turn = entry.from.ordinal + 1;
  return who + (files ? "，依据第 " + turn + " 轮用户的话：" + label + "/" + contextTurnPath(turn) : "，依据对话 " + label + " 第 " + turn + " 轮用户的话");
}
/** What makes the difference in authority plain, said once before the entries. */
export function boardAuthority(files: boolean): string {
  return "用户写的条目就是用户的要求；Harness 记的条目是那个 Harness 对用户原话的理解，括号里注明了它依据的是哪一轮" + (files ? "（路径相对于这件任务的记录目录）" : "")
    + "。拿不准一条是不是用户的本意、或者它和用户现在说的对不上时，" + (files ? "去读那一轮用户的原话" : "用 harnesshub 的 hub_read_turn 带上对话标签读那一轮用户的原话") + "，以原话为准。";
}
