import { codexDefaultInstructions } from "./codex-default-instructions.js";

interface CatalogEntry {
  slug: string;
  display_name: string;
  description: string;
  contextWindow: number;
  reasoning: boolean;
}

function catalog(entry: CatalogEntry) {
  // Codex's pinned baseline supplies instructions without a provider prompt override.
  return {
    models: [
      {
        slug: entry.slug,
        display_name: entry.display_name,
        description: entry.description,
        ...(entry.reasoning
          ? {
              default_reasoning_level: "high",
              supported_reasoning_levels: [
                { effort: "low", description: "Lower reasoning effort" },
                { effort: "high", description: "Higher reasoning effort" },
                { effort: "max", description: "Maximum reasoning effort" },
              ],
            }
          : { supported_reasoning_levels: [] }),
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: 1,
        support_verbosity: entry.reasoning,
        ...(entry.reasoning ? { default_verbosity: "low" } : {}),
        apply_patch_tool_type: "freeform",
        web_search_tool_type: "text",
        truncation_policy: { mode: "tokens", limit: 10_000 },
        context_window: entry.contextWindow,
        max_context_window: entry.contextWindow,
        effective_context_window_percent: 95,
        input_modalities: ["text"],
        supports_image_detail_original: false,
        experimental_supported_tools: [],
        default_reasoning_summary: "none",
        ...(entry.reasoning
          ? {}
          : { supports_reasoning_summary_parameter: false }),
        model_messages: { instructions_template: codexDefaultInstructions },
      },
    ],
  };
}

/** Known metadata only: unknown model names keep Codex's existing fallback behavior. */
export function codexModelCatalog(model: string) {
  if (model !== "deepseek-v4-flash") return undefined;
  // DeepSeek's official Codex integration supplies the capabilities/context.
  return catalog({
    slug: model,
    display_name: "DeepSeek-V4-Flash",
    description: "DeepSeek V4 Flash",
    contextWindow: 1_048_576,
    reasoning: true,
  });
}

/**
 * Catalog for the model-gateway alias (ADR 0013). The alias is unknown to
 * Codex, so its window comes from the unified model configuration instead of
 * Codex's name-based fallback. Reasoning levels are not advertised: the gateway
 * owns reasoning pass-through and Codex runs with `model_reasoning_effort = "none"`.
 */
export function codexGatewayCatalog(alias: string, contextWindow: number) {
  return catalog({
    slug: alias,
    display_name: alias,
    description: "HarnessHub unified model",
    contextWindow,
    reasoning: false,
  });
}
