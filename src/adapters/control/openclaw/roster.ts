/** OpenClaw's agent roster as its configuration file holds it (kept from the ACP driver; the capabilities page reads it). Pure. */
/** The most agents a roster may name for HarnessHub to read it. */
const MAX_AGENTS = 256;
/** One configured agent: its id as written (empty when the entry names none) and its entry (empty for the implicit `main`). */
export interface OpenClawAgent { readonly id: string; readonly entry: Readonly<Record<string, unknown>> }
/**
 * The agent roster of an openclaw.json, read the way OpenClaw reads it; pure, nothing is run. Which agent sessions without
 * an explicit target run as (`owner`):
 * - keyed `agents.entries`, the form 2026.10.5 requires (agents/agent-roster.ts and gateway/agent-list.ts at v2026.10.5):
 *   the one agent marked `default: true` unless `agents.ownership` is "explicit", else the sole agent, else in an explicit
 *   fleet the configured agent `agents.defaults.systemAgent.agentId` names; otherwise none (null), since OpenClaw then
 *   requires an explicit selection and HarnessHub does not pick one;
 * - the legacy `agents.list` array, which only Gateways that predate keyed rosters run with (2026.10.5 refuses it until
 *   its Doctor migrates it): the first agent marked `default: true`, else the first, else `main` (2026.3.23-2
 *   resolveDefaultAgentId);
 * - no roster: the implicit `main`.
 * `inherits` says whether that owner takes the shared default workspace when its own entry names none (OpenClaw's legacy
 * data owner: a marked, sole or implicit agent); the system agent of an explicit fleet does not. A shape OpenClaw would not
 * run with comes back as `problem` instead.
 */
export type OpenClawRoster = { readonly problem: string } | { readonly form: "entries" | "list" | "none"; readonly agents: readonly OpenClawAgent[];
  readonly defaults: Readonly<Record<string, unknown>>; readonly owner: OpenClawAgent | null; readonly inherits: boolean };
export function openClawRoster(config: unknown): OpenClawRoster {
  const plain = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!plain(config)) return { problem: "the configuration is not an object" };
  const agents = config.agents === undefined ? {} : config.agents, defaults = plain(agents) ? agents.defaults === undefined ? {} : agents.defaults : null;
  if (!plain(agents) || !plain(defaults)) return { problem: "invalid native agent settings" };
  const implicit: OpenClawAgent = { id: "main", entry: {} };
  // OpenClaw reads the keyed form whenever it is present, the array only without it (readAgentRosterProperty).
  if (agents.entries !== undefined) {
    const entries = agents.entries;
    if (!plain(entries) || Object.keys(entries).length > MAX_AGENTS) return { problem: "invalid native agent roster" };
    const roster: OpenClawAgent[] = [];
    for (const [id, entry] of Object.entries(entries)) { if (!plain(entry)) return { problem: "invalid native agent" }; roster.push({ id, entry }); }
    const explicit = agents.ownership === "explicit", marked = explicit ? [] : roster.filter(agent => agent.entry.default === true);
    if (marked.length === 1) return { form: "entries", agents: roster, defaults, owner: marked[0]!, inherits: true };
    if (roster.length === 1) return { form: "entries", agents: roster, defaults, owner: roster[0]!, inherits: true };
    const system = plain(defaults.systemAgent) && typeof defaults.systemAgent.agentId === "string" ? defaults.systemAgent.agentId.trim().toLowerCase() : "";
    return { form: "entries", agents: roster, defaults, owner: explicit && system ? roster.find(agent => agent.id.toLowerCase() === system) ?? null : null, inherits: false };
  }
  if (agents.list !== undefined) {
    const list = agents.list;
    if (!Array.isArray(list) || list.length > MAX_AGENTS) return { problem: "invalid native agent catalog" };
    const roster: OpenClawAgent[] = [];
    for (const entry of list) { if (!plain(entry)) return { problem: "invalid native agent" }; roster.push({ id: typeof entry.id === "string" ? entry.id : "", entry }); }
    const chosen = roster.find(agent => agent.entry.default === true) ?? roster[0];
    // An entry without an id stands for `main`, as OpenClaw names it; an id of another type is no agent id at all.
    const owner = chosen === undefined ? implicit : chosen.entry.id == null ? { id: "main", entry: chosen.entry } : chosen;
    return { form: "list", agents: roster, defaults, owner, inherits: true };
  }
  return { form: "none", agents: [], defaults, owner: implicit, inherits: true };
}
