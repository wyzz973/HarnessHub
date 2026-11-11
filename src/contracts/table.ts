import type { SessionId } from "./session.js";

/**
 * The context table: everything the Hub holds about one conversation, which a Harness may read for itself (docs/decisions/LOG.md,
 * 2026-11-11). The Hub pushes a little with each handoff; the rest is pulled through these tools.
 */

/** The environment a native process started by the Hub carries, and the Hub's tool process reads. Absent: not a Hub session. */
export const TABLE_ENV = { url: "HARNESSHUB_URL", session: "HARNESSHUB_SESSION" } as const;

/** The name of the Hub's own MCP entry in a Harness's configuration. */
export const TABLE_MCP_NAME = "harnesshub";

/** The read tools of the first slice. */
export const TABLE_TOOLS = ["hub_turns", "hub_read_turn", "hub_search"] as const;
export type TableTool = typeof TABLE_TOOLS[number];

/** What the tool process answers when it was not started inside a Hub session. */
export const TABLE_NOT_IN_SESSION = "Not inside a HarnessHub conversation: there is nothing to read here.";

/** Who a session token stands for: one Harness reading one conversation. */
export interface TableGrant { readonly sessionId: SessionId; readonly harnessId: string; readonly controlId: string }

/** Tokens the Hub hands a native process at launch. Opaque, unguessable, and worth nothing outside this machine. */
export interface TableGrants {
  mint(grant: TableGrant): string;
  resolve(token: string): TableGrant | null;
  revoke(sessionId: SessionId): void;
}

/** One line of the directory: a Turn, who ran it, and how it ended. `n` counts from 1 in conversation order. */
export interface TableTurnLine {
  readonly n: number; readonly harnessId: string; readonly status: string;
  readonly user: string; readonly reply: string; readonly tools: number; readonly files: number;
}
