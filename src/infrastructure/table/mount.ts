import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionId } from "../../contracts/session.js";
import { TABLE_COMMAND_DIR, TABLE_COMMAND_NAME, TABLE_ENV, type TableGrant, type TableGrants } from "../../contracts/table.js";
import { MemoryTableGrants } from "../session/table-grants.js";

/** What one native process is started with, and the end of its token. */
export interface TableAttachment {
  /** The two variables (TABLE_ENV) the process starts with: the Hub's address and this process's own token. */
  readonly env: Readonly<Record<string, string>>;
  /** The conversation's command, when one was asked for and could be written: the path a Harness runs to call the Hub's tools (HubToolsEntry `cli`). */
  readonly command?: string;
  /**
   * The process has ended, or was never started. Its Session's tokens go once no other process of that Session is left holding
   * one (the grants revoke by Session, and a Session can briefly have two: a kept process and the one of a switch). Idempotent.
   */
  detach(): void;
}

/**
 * Where the context table meets the native processes the Hub starts (docs/decisions/LOG.md, 2026-11-11): every process of a
 * Session gets the Hub's address and a token of its own in its environment, which the Hub's tool process inherits from it
 * (or has forwarded, where the Harness lets a tool see only some variables). One native process serves one Session, so the
 * token says which conversation a tool call belongs to; a process started any other way carries neither variable, and the
 * tool does nothing there. A new process is a new token: there is nothing to renew when a native session is resumed, and
 * nothing to keep when the Hub restarts.
 */
export class TableMount {
  private address: string | null = null;
  private installed: ((harnessId: string) => Promise<boolean>) | null = null;
  private readonly live = new Map<SessionId, number>();
  /** `commands`: the directory the commands of conversations are written under (`<data>/harnesshub-cli`); without it none is written. */
  constructor(readonly grants: TableGrants = new MemoryTableGrants(), private readonly commands: string | null = null) {}
  /**
   * Writes the command of a conversation (HubToolsEntry `cli`): a small script at a path that stays the same for the conversation, which
   * runs the Hub's tool program with the table's address and this process's token. Written anew for every process (a new token), owner-only;
   * what it holds is worth nothing once the process has ended. Null when it cannot be written: the process then has no such tools.
   */
  private writeCommand(session: SessionId, url: string, token: string): string | null {
    if (this.commands === null) return null;
    try {
      const tool = fileURLToPath(new URL("../../cli/hub-tools.js", import.meta.url));
      if (!existsSync(tool)) return null;
      const dir = join(this.commands, createHash("sha256").update(session).digest("hex").slice(0, 16)), path = join(dir, TABLE_COMMAND_NAME);
      const quoted = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Written beside and moved into place, so a command being run is never read half written.
      writeFileSync(path + ".next", "#!/bin/sh\n# HarnessHub: the tools of one conversation. Written by HarnessHub for each Turn.\n"
        + TABLE_ENV.url + "=" + quoted(url) + " " + TABLE_ENV.session + "=" + quoted(token) + " exec " + quoted(process.execPath) + " " + quoted(tool) + " \"$@\"\n", { mode: 0o700 });
      chmodSync(path + ".next", 0o700); renameSync(path + ".next", path);
      return path;
    } catch { return null; }
  }
  /** The Hub's address (the origin the tool process calls) once it listens; null before, and again once it stops. */
  listening(url: string | null): void { this.address = url; }
  get url(): string | null { return this.address; }
  /**
   * Who can tell whether a Harness's own configuration holds the Hub's tool entry as the Hub writes it now (the capability
   * service reads those files): given by whoever composes the Hub, null to take it back. Until it is given, no Harness is known to have the tools.
   */
  toolsIn(probe: ((harnessId: string) => Promise<boolean>) | null): void { this.installed = probe; }
  /**
   * Whether a native process of this Harness started now has the Hub's tools: the Harness's configuration holds the Hub's tool
   * entry (what a process started with the table's environment then runs). A probe that fails is a no; it never fails a start.
   * The caller has the process carry the environment (`attach`) and reads its own configuration home: this knows nothing of either.
   */
  async hasTools(harnessId: string): Promise<boolean> {
    const probe = this.installed;
    if (probe === null) return false;
    try { return await probe(harnessId) === true; } catch { return false; }
  }
  /** Mints a token for a process about to start; null while the Hub has no address, when the process then starts without the table. */
  attach(grant: TableGrant, options: { readonly command?: boolean } = {}): TableAttachment | null {
    const url = this.address;
    if (url === null) return null;
    const token = this.grants.mint(grant), session = grant.sessionId;
    this.live.set(session, (this.live.get(session) ?? 0) + 1);
    const command = options.command === true ? this.writeCommand(session, url, token) : null;
    let detached = false;
    return { env: { [TABLE_ENV.url]: url, [TABLE_ENV.session]: token }, ...(command === null ? {} : { command }),
      detach: () => {
        if (detached) return;
        detached = true;
        const left = (this.live.get(session) ?? 1) - 1;
        if (left > 0) { this.live.set(session, left); return; }
        this.live.delete(session); this.grants.revoke(session);
      } };
  }
}
