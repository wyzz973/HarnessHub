import type { ChannelRegistry, ControlRecipe } from "../contexts/catalog/domain/catalog.js";
import type { OfficialChannels } from "../contexts/catalog/domain/channels.js";

const CHECKED = "2026-10-17";
const none = { npm: [], brewFormulae: [], brewCasks: [], scripts: [], uv: [] } as const;
/**
 * Each product's official macOS installation channels (ADR-044), read from its own documentation on the date given; see
 * docs/research/official-install-channels-2026-10-17.md. A product absent here counts its control packages only.
 */
const products: Readonly<Record<string, OfficialChannels>> = {
  claude: { ...none, npm: ["@anthropic-ai/claude-code"], brewCasks: ["claude-code", "claude-code@latest"],
    scripts: [{ root: ".local/share/claude/versions", launchers: [], program: null }], source: { url: "https://code.claude.com/docs/en/setup", checkedAt: CHECKED } },
  codex: { ...none, npm: ["@openai/codex"], brewCasks: ["codex"],
    scripts: [{ root: ".codex/packages/standalone", launchers: [], program: null }], source: { url: "https://github.com/openai/codex", checkedAt: CHECKED } },
  opencode: { ...none, npm: ["opencode-ai"], brewFormulae: ["opencode"],
    scripts: [{ root: ".opencode/bin", launchers: [], program: null }], source: { url: "https://opencode.ai/docs", checkedAt: CHECKED } },
  openclaw: { ...none, npm: ["openclaw"], source: { url: "https://docs.openclaw.ai/install", checkedAt: CHECKED } },
  gemini: { ...none, npm: ["@google/gemini-cli"], brewFormulae: ["gemini-cli"], source: { url: "https://github.com/google-gemini/gemini-cli", checkedAt: CHECKED } },
  cursor: { ...none, scripts: [{ root: ".local/share/cursor-agent/versions", launchers: [], program: null }], source: { url: "https://cursor.com/docs/cli/installation", checkedAt: CHECKED } },
  pi: { ...none, npm: ["@earendil-works/pi-coding-agent"], source: { url: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent", checkedAt: CHECKED } },
  hermes: { ...none, scripts: [{ root: ".hermes/hermes-agent", launchers: [".local/bin/hermes"], program: "venv/bin/hermes" }],
    source: { url: "https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/README.md", checkedAt: CHECKED } },
  dsh: { ...none, npm: ["@deepseek-ai/dsh"], source: { url: "https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/README.md", checkedAt: CHECKED } },
};
/** The official channels of a product, or null when they are not recorded. */
export function productChannels(harnessId: string): OfficialChannels | null { return products[harnessId] ?? null; }
/**
 * The official channels of an adapter control in front of the product: the npm or Python package or the archive its
 * registry entry publishes. Returns null for a control that publishes none.
 */
export function adapterChannels(harnessId: string, control: ControlRecipe): OfficialChannels | null {
  if (control.package === null && control.distribution === null) return null;
  return { ...none, source: { url: control.source.url, checkedAt: CHECKED },
    npm: control.package?.kind === "npm" ? [control.package.name] : [], uv: control.package?.kind === "python" ? [control.package.name] : [],
    // A registry archive is installed under ~/.local/share/harnesses/<id> (ADR-017).
    scripts: control.distribution?.kind === "binary" ? [{ root: ".local/share/harnesses/" + harnessId, launchers: [], program: null }] : [] };
}
/** The registry of recorded channels the inventory classifies found programs with. */
export const channelRegistry: ChannelRegistry = { product: productChannels, adapter: adapterChannels };
