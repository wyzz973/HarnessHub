import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { capabilityReadTables, harnessDirectories, type ReadEnvironment } from "../../adapters/capability-reads.js";
import type { CapabilitiesView } from "../../contracts/capabilities.js";
import { at, parseConfig, record, text } from "./formats.js";
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

  /** The view for these installations; rejects only on an unexpected failure, since unreadable files are part of the view. */
  view(installed: readonly InstalledHarness[]): Promise<CapabilitiesView> {
    if (this.pending) return this.pending;
    const pending = this.scan(installed).finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }
  private async scan(installed: readonly InstalledHarness[]): Promise<CapabilitiesView> {
    const home = this.environment.home, homes = [home, await realpath(home).catch(() => home)];
    const hermesHome = await resolveHermesHome(this.environment), openclawWorkspace = await resolveOpenClawWorkspace(this.environment);
    return new CapabilityScan(this.environment, homes, hermesHome).view(capabilityReadTables(this.environment, { hermesHome, openclawWorkspace }), installed, this.now().toISOString());
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
/**
 * The default agent's workspace as OpenClaw resolves it (dist/workspace-*.js `resolveDefaultAgentWorkspaceDir`): the
 * default agent's `workspace`, else `agents.defaults.workspace`, else `~/.openclaw/workspace` (`workspace-<profile>`
 * under OPENCLAW_PROFILE). A configuration that does not parse falls back to the default; the view lists it as unreadable.
 */
export async function resolveOpenClawWorkspace(environment: ReadEnvironment): Promise<string> {
  const profile = environment.values.OPENCLAW_PROFILE?.trim();
  const fallback = join(environment.home, ".openclaw", profile && profile.toLowerCase() !== "default" ? "workspace-" + profile : "workspace");
  let source: string;
  try { source = await readFile(harnessDirectories(environment).openclawConfig, "utf8"); } catch { return fallback; }
  if (Buffer.byteLength(source) > 2 * 1024 * 1024) return fallback;
  const parsed = parseConfig(source, "json5");
  if (!parsed.ok) return fallback;
  const agents = at(parsed.value, ["agents", "list"]), list = Array.isArray(agents) ? agents.map(record) : [];
  const chosen = list.find(item => item.default === true) ?? list[0];
  const workspace = text(chosen?.workspace) ?? text(at(parsed.value, ["agents", "defaults", "workspace"]));
  return workspace === null ? fallback : workspace.replace(/^~(?=$|\/)/u, environment.home);
}
