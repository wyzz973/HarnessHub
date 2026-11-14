/*
 * A conversation's terminals as the API tells them (docs/contracts/public-api.md, "对话的终端"): login shells in the conversation's workspace that outlive
 * the page's sockets, each with the history of what it printed.
 */

/** How a terminal's shell ended: its exit status (null when a signal ended it) and the signal's name, such as `SIGKILL` (null when it exited). */
export interface TerminalExitView { readonly code: number | null; readonly signal: string | null }
/** One terminal of a conversation; `createdAt` in milliseconds since the epoch. `exited` once its shell has ended: it stays listed until it is closed. */
export interface TerminalView { readonly id: string; readonly title: string; readonly createdAt: number; readonly exited?: TerminalExitView }
/** GET /api/v1/sessions/:id/terminals: the conversation's terminals, the oldest first. */
export interface TerminalListView { readonly terminals: readonly TerminalView[] }
/** POST /api/v1/sessions/:id/terminals: the terminal that was opened. */
export interface TerminalOpenedView { readonly id: string; readonly title: string; readonly createdAt: number }
