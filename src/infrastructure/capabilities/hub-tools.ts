import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CapabilityError, type CapabilityChangeView, type HubToolsResult, type HubToolsTargetView, type HubToolsView, type McpTargetView } from "../../contracts/capabilities.js";
import { TABLE_ENV, TABLE_MCP_NAME } from "../../contracts/table.js";
import { sameMcp, type McpDefinition } from "./mcp-definitions.js";
import type { McpInventory } from "./mcp-changes.js";
import type { InstalledHarness } from "./scan.js";

/**
 * The Hub's own tools in the Harnesses' user-level MCP configuration (docs/decisions/LOG.md, 2026-11-11): one server, named
 * TABLE_MCP_NAME, that runs the Hub's tool program on the Node that runs the Hub. It is written once, by the same check, backup,
 * guard and read-back as any server of HarnessHub's MCP list, and is as visible and as removable there. The entry holds no
 * token and no address: the two table variables (TABLE_ENV) are named in it, for a Harness that lets its tools see only some
 * variables, and a Hub session's native process supplies them (TableMount); started any other way the tool finds neither
 * and does nothing.
 */

/** The program the entry runs: `cli/hub-tools.js` of the build that holds this module (dist/src/infrastructure/capabilities → dist/src/cli). */
function builtTool(): string { return fileURLToPath(new URL("../../cli/hub-tools.js", import.meta.url)); }

/**
 * Why the Hub's tools are not written into a Harness, or null when they are. Each one's user-level MCP configuration is written by
 * the MCP list's own rules (mcp-definitions.ts, mcp-edits.ts), the way that Harness documents it:
 * - Claude Code `~/.claude.json` `mcpServers` (its own `claude mcp add-json`), Codex `~/.codex/config.toml` `[mcp_servers.<name>]` with `env_vars`;
 * - OpenCode its config file's `mcp.<name>` (1) or `mcp.servers.<name>` (2), `type: "local"`, a command array and `{env:NAME}` (opencode.ai/v2/docs/mcp-servers);
 * - DeepSeek Harness a `@deepseek-ai/dsh-mcp-client` row of `~/.dsh/cordis.patch.yml` with `!!js process.env.NAME` (its docs/user/guide/mcp-memory.md);
 * - Hermes `config.yaml` `mcp_servers.<name>` with `command`, `args`, `env` (website/docs/reference/mcp-config-reference.md, `hermes mcp add`);
 * - OpenClaw `openclaw.json` `mcp.servers.<name>` with `command`, `args`, `env` (OpenClaw 2026.10.9 docs/tools/mcp.md, `openclaw mcp set`).
 * A Harness with no user-level MCP entry at all is not one of them (the default).
 */
function unavailable(harnessId: string): string | null {
  switch (harnessId) {
    case "claude": case "codex": case "opencode": case "dsh": case "hermes": case "openclaw": return null;
    default: return "Hub 的工具还没有接入这个 Harness。";
  }
}
/**
 * Why a Harness whose configuration holds the tools still cannot tell them which Hub conversation they serve, or null when it can. The identity
 * travels in the environment of the native process the Hub starts (TableMount): Claude Code's MCP servers inherit it (the named variables survive
 * CLAUDE_CODE_MCP_ALLOWLIST_ENV), Codex forwards what `env_vars` names, OpenCode passes `{env:NAME}`, DeepSeek Harness's entry reads
 * `process.env.NAME` (its bridge only drops names with KEY, PASSWORD, SECRET or TOKEN, which these are not). Hermes and OpenClaw run their
 * sessions and their MCP servers in the user's own gateway, which the Hub does not start: the servers see the gateway's environment, so the
 * tools answer that they are in no Hub conversation. Such a Harness is never told it has the tools (isInstalled).
 */
function sessionGap(harnessId: string): string | null {
  switch (harnessId) {
    case "hermes": return "Hermes 的会话和 MCP 服务器跑在用户自己的网关里，Hub 起的进程的环境变量传不到它：写进配置后工具能列出来，但认不出是哪个 Hub 对话，调用会回答不在 Hub 对话里。要按会话经 ACP 的 mcpServers 传入才行，还没有做。";
    case "openclaw": return "OpenClaw 的 MCP 服务器在它的 Gateway 进程里运行，用的是 Gateway 的环境：写进配置后工具能列出来，但认不出是哪个 Hub 对话，调用会回答不在 Hub 对话里。它的 ACP 桥不接受按会话传入的 MCP 服务器。";
    default: return null;
  }
}

/** What HarnessHub needs of the change service the tools are written through. */
export interface HubToolsHost {
  readonly mcp: McpInventory;
  /** Applies a checked change once (CapabilityChanges.apply). */
  apply(fingerprint: string, commandId: string): Promise<CapabilityChangeView>;
  /** Text with every spelling of the home directory written as ~. */
  show(text: string): string;
  /** A new command identity for an apply. */
  command(): string;
}
export interface HubToolsOptions {
  /** The Node that runs the tool program; the one running the Hub by default. */
  readonly node?: string;
  /** The tool program; `cli/hub-tools.js` of this build by default. */
  readonly tool?: string;
}

export class HubTools {
  constructor(private readonly host: HubToolsHost, private readonly options: HubToolsOptions = {}) {}

  private program(): { readonly node: string; readonly tool: string; readonly present: boolean } {
    const node = this.options.node ?? process.execPath, tool = this.options.tool ?? builtTool();
    let present = false;
    try { present = statSync(tool).isFile(); } catch { present = false; }
    return { node, tool, present };
  }
  /** The server as the list holds it: variables named in the order a read of any Harness's entry gives them (sorted by name). */
  private wanted(): McpDefinition {
    const { node, tool } = this.program();
    return { transport: "stdio", command: node, args: [tool, "mcp"], cwd: null, url: null,
      env: [TABLE_ENV.url, TABLE_ENV.session].sort((left, right) => left.localeCompare(right)).map(name => ({ key: name, variable: name })), headers: [] };
  }
  private row(harness: InstalledHarness, target: McpTargetView | undefined): HubToolsTargetView {
    const reason = unavailable(harness.harnessId);
    if (reason !== null) return { harnessId: harness.harnessId, name: harness.name, state: "unsupported", writable: false, reason, file: null };
    if (target === undefined) return { harnessId: harness.harnessId, name: harness.name, state: "unsupported", writable: false, reason: "读不到这个 Harness 的 MCP 配置", file: null };
    const gap = target.state === "unsupported" ? null : sessionGap(harness.harnessId);
    return { harnessId: harness.harnessId, name: harness.name, state: target.state, writable: target.state !== "unsupported", reason: [target.reason, gap].filter(Boolean).join(" ") || null, file: target.file };
  }
  /** Where `definition` stands in one Harness's file by the MCP list's own rules, whether or not the tools are written into that Harness. */
  private async stateOf(definition: McpDefinition, harnessId: string, installed: readonly InstalledHarness[]): Promise<McpTargetView> {
    const target = (await this.host.mcp.targets(TABLE_MCP_NAME, definition, installed)).find(item => item.harnessId === harnessId);
    return target ?? { harnessId, state: "unsupported", reason: "读不到这个 Harness 的 MCP 配置", file: null };
  }
  private harness(harnessId: string, installed: readonly InstalledHarness[]): InstalledHarness {
    const found = installed.find(item => item.harnessId === harnessId);
    if (found === undefined) throw new CapabilityError("CAPABILITY_NOT_FOUND", "这个 Harness 没有官网安装");
    return found;
  }

  /**
   * Whether a Harness's configuration holds the Hub's tools exactly as an install now would write them (or an identical entry
   * nobody recorded): what a native process the Hub starts there can be told it has. The entry as HarnessHub wrote it earlier but
   * that differs from today's (another build, another Node), one someone changed, and a same-named entry of someone else's are
   * not known to work and say no, as does a Harness the tools are not written into and a tool program that is not built. Read only;
   * reads the one Harness's file.
   */
  async isInstalled(harnessId: string, installed: readonly InstalledHarness[]): Promise<boolean> {
    const mine = installed.filter(item => item.harnessId === harnessId);
    if (mine.length === 0 || unavailable(harnessId) !== null || sessionGap(harnessId) !== null || !this.program().present) return false;
    const state = (await this.stateOf(this.wanted(), harnessId, mine)).state;
    return state === "synced" || state === "claimable";
  }

  /** Where the Hub's tools stand in every installed Harness, by what an install now would write. Read only. */
  async view(installed: readonly InstalledHarness[]): Promise<HubToolsView> {
    const { node, tool, present } = this.program(), wanted = this.wanted(), targets = await this.host.mcp.targets(TABLE_MCP_NAME, wanted, installed);
    return { name: TABLE_MCP_NAME, tool: { command: this.host.show([node, tool, "mcp"].join(" ")), present },
      harnesses: installed.map(harness => this.row(harness, targets.find(target => target.harnessId === harness.harnessId))) };
  }

  /**
   * Writes the Hub's tools into one Harness: the list gets the server as the Hub wants it now, and the same check and apply as
   * any server's follow in one request. Already there as wanted is `unchanged`; an identical entry nobody recorded becomes
   * HarnessHub's with no file change; one HarnessHub wrote and someone changed or removed is written again, since the user
   * asks for it; a same-named entry of someone else's, and a Harness the tools are not written into yet, are refused.
   */
  async install(harnessId: string, installed: readonly InstalledHarness[]): Promise<HubToolsResult> {
    this.harness(harnessId, installed);
    const reason = unavailable(harnessId);
    if (reason !== null) throw new CapabilityError("CAPABILITY_UNSUPPORTED", reason);
    const { tool, present } = this.program(), wanted = this.wanted();
    if (!present) throw new CapabilityError("CAPABILITY_UNSUPPORTED", "Hub 的工具程序还没有构建：找不到 " + this.host.show(tool));
    const before = await this.stateOf(wanted, harnessId, installed);
    if (before.state === "unsupported") throw new CapabilityError("CAPABILITY_UNSUPPORTED", before.reason ?? "这个 Harness 的 MCP 配置不能写");
    if (before.state === "different") throw new CapabilityError("CAPABILITY_TARGET_REFUSED", before.reason ?? "已有同名的服务器，定义不同；HarnessHub 不覆盖");
    if (before.state === "synced") return { harnessId, action: "install", status: "unchanged", state: "synced", changes: [], notes: ["已经装好了。"] };
    const listed = this.host.mcp.listed(TABLE_MCP_NAME);
    if (listed === undefined) this.host.mcp.save(TABLE_MCP_NAME, wanted, false);
    else if (!sameMcp(listed, wanted)) this.host.mcp.save(TABLE_MCP_NAME, wanted, true);
    // The same entry is there but nobody recorded it as HarnessHub's: it becomes so, and no file changes.
    if (before.state === "claimable") {
      const changes = await this.host.mcp.claim(TABLE_MCP_NAME, [harnessId], installed);
      return { harnessId, action: "install", status: "done", state: (await this.stateOf(wanted, harnessId, installed)).state, changes, notes: ["配置里已经有一模一样的一项，记为 HarnessHub 管理的；文件没有改动。", ...[sessionGap(harnessId)].filter((note): note is string => note !== null)] };
    }
    const check = await this.host.mcp.checkSync(TABLE_MCP_NAME, harnessId, before.state === "changed" || before.state === "removed", installed);
    if (check.blocked !== null) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", check.blocked);
    const change = await this.host.apply(check.fingerprint, this.host.command()), gap = sessionGap(harnessId);
    return { harnessId, action: "install", status: change.status === "applied" ? "done" : "failed", state: (await this.stateOf(wanted, harnessId, installed)).state, changes: [change], notes: gap === null ? check.notes : [...check.notes, gap] };
  }

  /**
   * Takes the Hub's tools out of one Harness: only the entry HarnessHub wrote (or an identical one recorded as its own) and
   * nobody changed since; an entry that is not, or one that is not there, is left alone. The server leaves HarnessHub's list
   * with the last Harness that held it.
   */
  async uninstall(harnessId: string, installed: readonly InstalledHarness[]): Promise<HubToolsResult> {
    this.harness(harnessId, installed);
    const wanted = this.wanted(), done = (status: HubToolsResult["status"], state: HubToolsResult["state"], changes: readonly CapabilityChangeView[], notes: readonly string[]): HubToolsResult =>
      ({ harnessId, action: "uninstall", status, state, changes, notes });
    const listed = this.host.mcp.listed(TABLE_MCP_NAME), before = await this.stateOf(listed ?? wanted, harnessId, installed);
    if (before.state === "unsupported") throw new CapabilityError("CAPABILITY_UNSUPPORTED", before.reason ?? "这个 Harness 的 MCP 配置不能写");
    if (before.state === "absent" || before.state === "removed") return done("unchanged", before.state, [], ["配置里没有这一项。"]);
    if (before.state === "different" || before.state === "changed") throw new CapabilityError("CAPABILITY_TARGET_REFUSED", "这一项不是 HarnessHub 写的（或已被外部改过），HarnessHub 不删。");
    // The removal goes through the list's entry; a list that lost it (a fresh data directory) gets it back for the moment.
    if (listed === undefined) this.host.mcp.save(TABLE_MCP_NAME, wanted, false);
    const changes: CapabilityChangeView[] = [];
    if (before.state === "claimable") changes.push(...await this.host.mcp.claim(TABLE_MCP_NAME, [harnessId], installed));
    const check = await this.host.mcp.checkRemove(TABLE_MCP_NAME, harnessId, installed);
    if (check.blocked !== null) throw new CapabilityError("CAPABILITY_TARGET_REFUSED", check.blocked);
    const change = await this.host.apply(check.fingerprint, this.host.command());
    changes.push(change);
    // No Harness holds it any more: the list does not keep it either (the list refuses while one does).
    if (change.status === "applied") { try { await this.host.mcp.remove(TABLE_MCP_NAME, installed); } catch (error) { if (!(error instanceof CapabilityError)) throw error; } }
    return done(change.status === "applied" ? "done" : "failed", (await this.stateOf(this.host.mcp.listed(TABLE_MCP_NAME) ?? wanted, harnessId, installed)).state, changes, check.notes);
  }
}
