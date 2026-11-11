import { MAX_RELAY_MODEL_BYTES, type VendorKey, type VendorObservation } from "../../contracts/relay.js";

/**
 * What a Driver's declaration still says of the model and the vendor it hands over to.
 *
 * The relay hands a conversation to a Harness, by that Harness's name; it does not work out which vendor serves the Harness's
 * model requests, and no Driver reads the user's Harness configuration to find out (the decision log of 2026-11-11). So there is
 * one vendor key per Harness, `unknown:<harness>`, and the model keys below, which only tell a model's name from its provider
 * prefix and version decorations.
 */

/** The vendor key a Driver declares: the Harness's own name, since no endpoint is read any more. */
export function harnessVendor(harness: string): (observed: VendorObservation) => VendorKey {
  const key: VendorKey = `unknown:${harness}`;
  return () => key;
}

/** A provider name as a model prefix names it. */
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
/** The provider a model names by its prefix before `separator`, lower case; null without one. */
function providerOf(model: string | null, separator: "/" | ":"): string | null {
  const index = model?.indexOf(separator) ?? -1;
  if (model === null || index < 1) return null;
  const name = model.slice(0, index).trim().toLowerCase();
  return PROVIDER.test(name) ? name : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Model keys
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A model's version decorations removed, lower case: a Bedrock id's region and `anthropic.` prefix with its `-vN:M`
 * suffix, a Vertex `@date` or `@latest`, a dated snapshot (`-20250929`, `-2024-08-06`) and `-latest`. An alias a CLI
 * resolves at run time (Claude Code's `opus`, `sonnet`…) stays its own key: which model it names depends on the version.
 */
function undecorated(model: string): string {
  let key = model.trim().toLowerCase();
  const bedrock = /^(?:(?:us|eu|apac|global|jp|au|ca)\.)?anthropic\.(.+?)(?:-v\d+(?::\d+)?)?$/u.exec(key);
  if (bedrock !== null) key = bedrock[1]!;
  return key.replace(/@(?:\d{8}|latest)$/u, "").replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/u, "").replace(/-latest$/u, "");
}
function bounded(key: string): string { return key !== "" && Buffer.byteLength(key) <= MAX_RELAY_MODEL_BYTES ? key : ""; }
/**
 * The model key of a Driver whose models carry a `provider/` prefix, or none (Claude Code, Codex, OpenCode, OpenClaw,
 * DeepSeek Harness): the last `/` segment without its decorations; "" for null, an empty result or one over 96 bytes.
 */
export function slashModelKey(model: string | null): string {
  if (model === null) return "";
  const last = model.trim().split("/").at(-1) ?? "";
  return bounded(undecorated(last));
}
/** A JSON array text longer than this is not parsed: a model the observation keeps is far shorter (MAX_RELAY_MODEL_BYTES). */
const MODEL_ARRAY_BYTES = 1024;
/**
 * DeepSeek Harness's model key. dsh reports its model as a JSON array text of the provider and the model, such as
 * `["deepseek-official","deepseek-v4-flash"]`, and the model that runs is the array's last item (probe record 2026-11-10, F8:
 * the key was that whole text). The last item goes through slashModelKey; an array whose last item is no string (an empty array,
 * a number, null, an object or a nested array) names no model: "". Any other text, invalid JSON and a non-array included, is
 * read as slashModelKey reads it.
 */
export function dshModelKey(model: string | null): string {
  if (model === null) return "";
  const text = model.trim();
  if (text.startsWith("[") && text.endsWith("]") && Buffer.byteLength(text) <= MODEL_ARRAY_BYTES) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return slashModelKey(model); }
    if (Array.isArray(parsed)) { const last = parsed.at(-1); return typeof last === "string" ? slashModelKey(last) : ""; }
  }
  return slashModelKey(model);
}
/**
 * Hermes's model key: its models are `<provider>:<model>` (server.py `_encode_model_choice`), so the provider before the
 * first colon goes, then any `/` path, then the decorations; "" for null, an empty result or one over 96 bytes.
 */
export function hermesModelKey(model: string | null): string {
  if (model === null) return "";
  const text = model.trim(), provider = providerOf(text, ":");
  return slashModelKey(provider === null ? text : text.slice(text.indexOf(":") + 1));
}
