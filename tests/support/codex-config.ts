// SPDX-License-Identifier: MIT
import { editors } from "@harnesshub/agents/wiring/formats/index";

/**
 * Codex's `config.toml` after unwire, when wiring found it as `original`
 * and left it unchanged since: the original bytes with the provider table
 * that unwire leaves, without the key, for threads started on it.
 * `openaiBaseUrl` is the gateway's `/v1` base.
 */
export function codexUnwired(original: string, openaiBaseUrl: string): string {
  return editors.toml.set(original, ["model_providers", "harnesshub"], {
    name: "HarnessHub",
    base_url: openaiBaseUrl,
    wire_api: "responses",
  });
}
