import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { capabilityReadTables, harnessDirectories, type ReadEnvironment } from "../../adapters/capability-reads.js";
import { openClawRoster } from "../../adapters/control/openclaw.js";
import type { CapabilitiesView } from "../../contracts/capabilities.js";
import { parseConfig, text } from "./formats.js";
import { CapabilityScan, type InstalledHarness } from "./scan.js";

export type { InstalledHarness } from "./scan.js";

/**
 * The read-only capability view of ADR-045 step 1: what every installed Harness reads besides its model, from the user's
 * own files in `environment` (never a substitute home). Nothing is written, no Harness command runs and no MCP server is
 * started or contacted. One scan runs at a time; a request during a scan shares its result.
 */
export class CapabilityService {
  private pending: Promise<CapabilitiesView> | null = null;
  constructor(private readonly environment: ReadEnvironment, private readonly now: () => Date = () => new Date()) {}

  /**
   * The view for these installations; rejects only on an unexpected failure, since unreadable files are part of the view.
   * `placed`: the links HarnessHub placed for shared skills (absolute paths), shown on their entries. `ours`: the skills
   * HarnessHub installed in the shared directory (folder name → repository), shown as HarnessHub's.
   */
  view(installed: readonly InstalledHarness[], placed: ReadonlySet<string> = new Set(), ours: ReadonlyMap<string, string> = new Map()): Promise<CapabilitiesView> {
    if (this.pending) return this.pending;
    const pending = this.scan(installed, placed, ours).finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }
  private async scan(installed: readonly InstalledHarness[], placed: ReadonlySet<string>, ours: ReadonlyMap<string, string>): Promise<CapabilitiesView> {
    const home = this.environment.home, homes = [home, await realpath(home).catch(() => home)];
    const hermesHome = await resolveHermesHome(this.environment), openclawWorkspace = await resolveOpenClawWorkspace(this.environment);
    return new CapabilityScan(this.environment, homes, hermesHome, placed, ours).view(capabilityReadTables(this.environment, { hermesHome, openclawWorkspace }), installed, this.now().toISOString());
  }
}

/**
 * Hermes's home as `hermes` resolves it without a profile flag (hermes_cli/main.py `_apply_profile_override`):
 * HERMES_HOME when set, else the sticky profile named in `~/.hermes/active_profile`, else `~/.hermes`.
 */
export async function resolveHermesHome(environment: ReadEnvironment): Promise<string> {
  const explicit = environment.values.HERMES_HOME;
  if (explicit) return explicit.replace(/^~(?=$|\/)/u, environment.home);
  const root = join(environment.home, ".hermes");
  let name: string;
  try { name = (await readFile(join(root, "active_profile"), "utf8")).trim(); } catch { return root; }
  if (!name || name === "default" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(name)) return root;
  const profile = join(root, "profiles", name);
  return (await stat(profile).catch(() => null))?.isDirectory() ? profile : root;
}
/** A profile name OpenClaw accepts (cli/profile-utils.ts); another one names no profile directory. */
const OPENCLAW_PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;
/**
 * The workspace OpenClaw falls back to (agents/workspace-default-path.ts at v2026.10.5): OPENCLAW_WORKSPACE_DIR, else
 * `<state dir>/workspace` under OPENCLAW_STATE_DIR, else `~/.openclaw-<profile>/workspace` for a named OPENCLAW_PROFILE,
 * else ~/.openclaw/workspace. `~/` in a variable is the home; a workspace variable that is still relative names nothing
 * HarnessHub can place (OpenClaw resolves it against its own working directory), so the next rule applies.
 */
function defaultOpenClawWorkspace(environment: ReadEnvironment, stateDir: string): string {
  const value = (name: string): string | null => { const raw = environment.values[name]?.trim(); return raw ? raw.replace(/^~(?=$|\/)/u, environment.home) : null; };
  const explicit = value("OPENCLAW_WORKSPACE_DIR"), profile = value("OPENCLAW_PROFILE");
  if (explicit !== null && isAbsolute(explicit)) return resolve(explicit);
  if (value("OPENCLAW_STATE_DIR") !== null) return join(stateDir, "workspace");
  if (profile !== null && profile.toLowerCase() !== "default" && OPENCLAW_PROFILE.test(profile)) return join(environment.home, ".openclaw-" + profile, "workspace");
  return join(environment.home, ".openclaw", "workspace");
}
/**
 * The workspace of the agent HarnessHub's OpenClaw sessions run as, as OpenClaw resolves it (agents/agent-scope-config.ts
 * `resolveAgentWorkspaceDir` at v2026.10.5; the roster rules are the driver's, openClawRoster): that agent's own
 * `workspace`; else, for an owner that inherits it (a marked, sole or implicit agent, and the default agent of a legacy
 * `agents.list`), `agents.defaults.workspace` or OpenClaw's default workspace; else `<agents.defaults.workspace>/<id>` or
 * `<state dir>/workspace-<id>`, as for the system agent of an explicit fleet. A roster without an owner is shown with its
 * first agent, the one OpenClaw's own agent list puts first; HarnessHub writes nothing there (the instructions refuse).
 * A configuration that does not parse falls back to the default workspace; the view lists it as unreadable.
 */
export async function resolveOpenClawWorkspace(environment: ReadEnvironment): Promise<string> {
  const dirs = harnessDirectories(environment), fallback = defaultOpenClawWorkspace(environment, dirs.openclaw);
  let source: string;
  try { source = await readFile(dirs.openclawConfig, "utf8"); } catch { return fallback; }
  if (Buffer.byteLength(source) > 2 * 1024 * 1024) return fallback;
  const parsed = parseConfig(source, "json5");
  if (!parsed.ok) return fallback;
  const roster = openClawRoster(parsed.value);
  if ("problem" in roster) return fallback;
  const home = (path: string) => path.replace(/^~(?=$|\/)/u, environment.home), named = (value: unknown) => text(value)?.trim() || null;
  const agent = roster.owner ?? roster.agents[0], root = named(roster.defaults.workspace);
  const own = named(agent?.entry.workspace);
  if (own !== null) return home(own);
  if (agent === undefined || (roster.owner !== null && roster.inherits)) return root === null ? fallback : home(root);
  return root === null ? join(dirs.openclaw, "workspace-" + agent.id.toLowerCase()) : join(home(root), agent.id.toLowerCase());
}
