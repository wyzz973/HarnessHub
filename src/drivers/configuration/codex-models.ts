import { codexDefaultInstructions } from "./codex-default-instructions.js";

/** Known metadata only: unknown model names keep Codex's existing fallback behavior. */
export function codexModelCatalog(model: string) {
  if (model !== "deepseek-v4-flash") return undefined;
  // DeepSeek's official Codex integration supplies the capabilities/context;
  // Codex's pinned baseline supplies instructions without a provider prompt override.
  return {
    models: [
      {
        slug: model,
        display_name: "DeepSeek-V4-Flash",
        description: "DeepSeek V4 Flash",
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "low", description: "Lower reasoning effort" },
          { effort: "high", description: "Higher reasoning effort" },
          { effort: "max", description: "Maximum reasoning effort" },
        ],
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: 1,
        support_verbosity: true,
        default_verbosity: "low",
        apply_patch_tool_type: "freeform",
        web_search_tool_type: "text",
        truncation_policy: { mode: "tokens", limit: 10_000 },
        context_window: 1_048_576,
        max_context_window: 1_048_576,
        effective_context_window_percent: 95,
        input_modalities: ["text"],
        supports_image_detail_original: false,
        experimental_supported_tools: [],
        default_reasoning_summary: "none",
        model_messages: { instructions_template: codexDefaultInstructions },
      },
    ],
  };
}
