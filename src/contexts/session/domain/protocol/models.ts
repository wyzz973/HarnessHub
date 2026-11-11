import type { ModelRef } from "../../../../contracts/protocol.js";

/**
 * A model as the interface names it (docs/proposals/protocol/hub-protocol.html §5): the name the Harness's own model catalog gives
 * (what the message box's picker shows, "Opus 5.5") when the Hub has one, else the native spelling tidied so that no JSON, provider
 * prefix or all-lowercase slug reaches a person. The native spelling stays as the model's `id`. Pure.
 */

/** Words that are written another way than their first letter capitalised. */
const BRAND: ReadonlyMap<string, string> = new Map(Object.entries({ gpt: "GPT", glm: "GLM", oss: "OSS", deepseek: "DeepSeek", minimax: "MiniMax", openai: "OpenAI", ai: "AI", llm: "LLM", xai: "xAI" }));
/** A prefix before `:` that names a provider, not a model: `deepseek:deepseek-flash` is a Hermes model, `llama3:8b` is a tag. */
const PROVIDERS = new Set(["deepseek", "openai", "anthropic", "google", "gemini", "openrouter", "xai", "mistral", "moonshot", "zhipu", "zai", "qwen", "alibaba", "minimax", "groq", "together", "azure", "bedrock", "vertex", "copilot", "nous", "opencode", "kimi"]);
/** Who makes a model, by the first word of its name. */
const VENDORS: ReadonlyMap<string, string> = new Map(Object.entries({
  claude: "Anthropic", opus: "Anthropic", sonnet: "Anthropic", haiku: "Anthropic", gpt: "OpenAI", codex: "OpenAI", gemini: "Google", deepseek: "DeepSeek", glm: "Zhipu AI",
  qwen: "Alibaba", kimi: "Moonshot AI", minimax: "MiniMax", mistral: "Mistral AI", codestral: "Mistral AI", llama: "Meta", grok: "xAI",
}));
const MAX_LABEL = 80;

/** The last model of a native spelling that is a JSON list (`["deepseek-official","deepseek-flash"]`: provider, then model); the text otherwise. */
function modelText(native: string): string {
  const text = native.trim();
  if (!text.startsWith("[")) return text;
  try {
    const list: unknown = JSON.parse(text);
    const names = Array.isArray(list) ? list.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
    return names.length ? names.at(-1)!.trim() : text;
  } catch { return text; }
}
function word(text: string): string {
  const known = BRAND.get(text.toLowerCase());
  if (known !== undefined) return known;
  // `v4`, `r1`, `k2`: a letter and a number are a name (OpenAI's `o3` stays as it is).
  if (/^[a-z]\d+(?:\.\d+)*$/u.test(text)) return /^o\d/u.test(text) ? text : text.toUpperCase();
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}
/**
 * `claude-opus-5-5` → `Claude Opus 5.5`, `glm-5.3-flash-free` → `GLM 5.3 Flash Free`, `opencode/deepseek-flash` → `DeepSeek Flash`.
 * Hermes writes `provider:model`, so its prefix always goes; for any other Harness only a prefix that names a provider does.
 */
function tidy(harnessId: string, native: string): { readonly label: string; readonly first: string } {
  let text = modelText(native);
  // A context-size variant (`opus[1m]`) is kept as the size it names.
  const variant = /\[([^\]]*)\]$/u.exec(text)?.[1];
  text = text.replace(/\[[^\]]*\]$/u, "");
  text = text.slice(text.lastIndexOf("/") + 1);
  const colon = text.indexOf(":");
  if (colon > 0 && (harnessId === "hermes" || PROVIDERS.has(text.slice(0, colon).toLowerCase()))) text = text.slice(colon + 1);
  text = text.replace(/[-_]?\d{8}$/u, "").replace(/-\d{4}-\d{2}-\d{2}$/u, "");
  const parts = text.split(/[-_\s]+/u).filter(Boolean), words: string[] = [];
  for (const part of parts) {
    // Numbers a hyphen separates are one version: `5-5` is `5.5`.
    const previous = words.at(-1);
    if (previous !== undefined && /^\d{1,2}$/u.test(part) && /^\d{1,2}$/u.test(previous)) words[words.length - 1] = previous + "." + part;
    else words.push(part);
  }
  const label = words.map(word).join(" ") + (variant === undefined || variant === "" ? "" : " " + variant.toUpperCase());
  return { label: label.trim(), first: (parts[0] ?? "").toLowerCase() };
}

/**
 * The model's reference. `catalogName` is the display name the Harness's catalog gives this native model, when the Hub has read
 * one; it wins. Without it the label is the native spelling tidied (and the spelling itself when nothing is left of it).
 */
export function modelLabel(harnessId: string, native: string, catalogName?: string | null): ModelRef {
  const named = typeof catalogName === "string" ? catalogName.replace(/\s+/gu, " ").trim() : "", { label, first } = tidy(harnessId, native);
  const vendor = VENDORS.get(first) ?? (/^o\d/u.test(first) ? "OpenAI" : undefined);
  return { id: native.slice(0, 256), label: (named !== "" ? named : label !== "" ? label : native.trim()).slice(0, MAX_LABEL), ...(vendor === undefined ? {} : { vendor }) };
}
