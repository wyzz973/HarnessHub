// SPDX-License-Identifier: MIT
/**
 * The model a wired agent is set to use in place of one it named that the
 * gateway does not serve (Magpie's `StandIn`, `internal/agent/claude.go`
 * and `codex.go`, yetone/magpie@2e340f7): Claude Code asks for
 * `claude-haiku-…` by name for titles and small tasks whatever its tiers
 * are set to, and a model of a tier goes to that tier's model; Codex's
 * goes to the model it is wired to. Only Claude Code and Codex, as in
 * Magpie; the choices come from HarnessHub's wiring record rather than
 * from the agent's files.
 */
import type { WiringRecord } from "@harnesshub/core/model-plane";

/** Claude Code's tiers, in the order Magpie looks for them in a model's name. */
const CLAUDE_TIERS = ["opus", "sonnet", "haiku", "fable"] as const;

/** A model as Claude Code is given it, without the 1M-window mark. */
const bare = (model: string) => model.replace(/\[1m\]$/, "");

/**
 * The model `wiring`'s agent stands in for `asked`, or undefined when it
 * has none or would stand in the same name: for Claude Code, its main model
 * when `asked` is that model; otherwise the model of the first tier whose
 * name `asked` contains (opus, sonnet, haiku, fable), falling back to the
 * main model; for Codex outside its ChatGPT mode, its model.
 */
export function standIn(
  wiring: WiringRecord,
  asked: string,
): string | undefined {
  const main = wiring.model;
  if (main === undefined) return undefined;
  let model: string | undefined;
  if (wiring.adapterId === "claude") {
    const lower = asked.toLowerCase();
    const tier =
      bare(main) === bare(asked)
        ? undefined
        : CLAUDE_TIERS.find((name) => lower.includes(name));
    model = (tier && wiring.tiers?.[tier]) ?? main;
  } else if (
    wiring.adapterId === "codex" &&
    wiring.options?.codexAuth !== "chatgpt"
  )
    model = main;
  return model === undefined || model === asked ? undefined : model;
}
