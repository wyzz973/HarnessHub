import type { ModelProviderConfiguration } from "./engine-configuration.js";

/**
 * The single model every engine uses. `provider.protocol` is the upstream protocol;
 * engines reach it only through the Worker-owned model gateway (ADR 0013).
 */
export interface HarnessModel {
  /** Real upstream model id, e.g. `GLM-V5_1-DX`. */
  model: string;
  /** Model id shown to engines. Defaults to {@link HARNESS_MODEL_ALIAS}. */
  alias?: string;
  provider: ModelProviderConfiguration;
}

/** Neutral id shown to engines so name-based routing or limit heuristics do not apply. */
export const HARNESS_MODEL_ALIAS = "harnesshub-model";

/** Environment variables that define the unified model for unattended startup. */
export const harnessModelEnvironment = {
  model: "HARNESSHUB_MODEL",
  baseUrl: "HARNESSHUB_MODEL_BASE_URL",
  /** Holds the key value itself; configuration stores only `{kind:"env",value:<this name>}`. */
  apiKey: "HARNESSHUB_MODEL_API_KEY",
  /** Defaults to `openai-completions`. */
  protocol: "HARNESSHUB_MODEL_PROTOCOL",
  contextWindow: "HARNESSHUB_MODEL_CONTEXT_WINDOW",
  maxOutputTokens: "HARNESSHUB_MODEL_MAX_OUTPUT_TOKENS",
  /** Comma-separated extra upstream parameters to remove (`compatibility.dropParameters`). */
  dropParameters: "HARNESSHUB_MODEL_DROP_PARAMETERS",
  /** `passthrough` or `strip` (`compatibility.reasoning`). */
  reasoning: "HARNESSHUB_MODEL_REASONING",
  /** `placeholder` or `passthrough` (`compatibility.images`). */
  images: "HARNESSHUB_MODEL_IMAGES",
} as const;

export interface HarnessModelEngineStatus {
  engineId: string;
  status: "applied" | "unsupported" | "disabled";
  reason?: string;
}

/** Public view. It carries secret references only, never secret values. */
export interface HarnessModelView {
  configured: boolean;
  source?: "environment" | "file" | "settings";
  model?: string;
  alias: string;
  provider?: ModelProviderConfiguration;
  engines: HarnessModelEngineStatus[];
}
