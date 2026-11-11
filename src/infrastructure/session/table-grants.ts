import { createHash, randomBytes } from "node:crypto";
import type { SessionId } from "../../contracts/session.js";
import type { TableGrant, TableGrants } from "../../contracts/table.js";

/** At most this many tokens are alive at once; the oldest go first. A Hub that revokes the tokens of the Turns that ended never reaches it. */
const MAX_TOKENS = 4096;

/**
 * The context table's tokens, in memory only (src/contracts/table.ts): a token is 256 random bits, handed to a native process the
 * Hub starts and worth nothing once the Hub stops or revokes the Session. Only a digest of each token is kept, so the table
 * holds nothing a token could be read back from. Never persisted, never logged.
 */
export class MemoryTableGrants implements TableGrants {
  private readonly rows = new Map<string, TableGrant>();
  private static digest(token: string): string { return createHash("sha256").update(token, "utf8").digest("hex"); }
  mint(grant: TableGrant): string {
    const token = "hht_" + randomBytes(32).toString("base64url");
    this.rows.set(MemoryTableGrants.digest(token), { sessionId: grant.sessionId, harnessId: grant.harnessId, controlId: grant.controlId });
    while (this.rows.size > MAX_TOKENS) this.rows.delete(this.rows.keys().next().value!);
    return token;
  }
  resolve(token: string): TableGrant | null {
    if (typeof token !== "string" || token.length < 16 || token.length > 512) return null;
    const grant = this.rows.get(MemoryTableGrants.digest(token));
    return grant === undefined ? null : { ...grant };
  }
  revoke(sessionId: SessionId): void {
    for (const [digest, grant] of this.rows) if (grant.sessionId === sessionId) this.rows.delete(digest);
  }
  /** How many tokens are alive. */
  get size(): number { return this.rows.size; }
}
