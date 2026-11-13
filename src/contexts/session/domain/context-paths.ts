/**
 * Where the pieces of a conversation's record are in its directory (src/web/context-files.ts writes them; the relay packet and the table name them): the address of a
 * Turn is the path of its file, inside the directory of its conversation.
 */
const padded = (n: number, width: number): string => String(n).padStart(width, "0");
/** Where a Turn's file is, inside its conversation's directory. */
export const contextTurnPath = (n: number): string => "turns/" + padded(n, 3) + ".md";
/** Where one text of one tool call of a Turn is when it has a file of its own. */
export const contextBlobPath = (n: number, k: number, part: "input" | "output" | "diff"): string => "turns/" + padded(n, 3) + "/tool-" + padded(k, 2) + "." + (part === "diff" ? "diff" : part + ".txt");
/** The index of a conversation: one entry a Turn. */
export const CONTEXT_INDEX = "index.md";
