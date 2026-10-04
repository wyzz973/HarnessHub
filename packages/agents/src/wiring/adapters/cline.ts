// SPDX-License-Identifier: MIT
import path from "node:path";
import type { ConfigValue } from "../formats/index.js";
import {
  outputLimit,
  withSelected,
  type AdapterEnvironment,
  type FileLocation,
  type WiringAdapter,
} from "./types.js";

/** Cline's built-in provider that wiring takes over. */
const SLOT = "openai-compatible";

/** Cline refuses settings files without their schema version. */
const INITIAL = `{
  "version": 1
}
`;

/**
 * Cline CLI 3.x reads `settings/providers.json` and `settings/models.json` in
 * `$CLINE_DATA_DIR`, else `${CLINE_DIR:-~/.cline}/data`. Cline refuses a
 * provider of one's own when a session starts (cline/cline#14180), so wiring
 * takes over its built-in `openai-compatible` provider: Chat Completions at
 * `<gateway>/v1` with the key, the chosen model, and `lastUsedProvider`
 * selecting it. That provider lists only one model of its own, so the
 * gateway's models go to its entry in `models.json`, in the shape Cline's
 * own migration writes, with `images` and `reasoning` among a model's
 * capabilities when it has them; the effort is the slot's `reasoning`
 * (`{enabled: false}` for none). Unwire restores the slot the user had
 * (Magpie's `cline.go`). The VS Code extension's own state (`globalState.json`,
 * `secrets.json`), which it reads before these files, is not wired.
 */
export const cline: WiringAdapter = {
  id: "cline",
  name: "Cline",
  protocol: "chat",
  keyDelivery: "config-file",
  executables: ["cline"],
  files: [
    {
      id: "providers",
      format: "json",
      locate: (e) => clineFile(e, "providers.json"),
      initial: INITIAL,
    },
    {
      id: "models",
      format: "json",
      locate: (e) => clineFile(e, "models.json"),
      initial: INITIAL,
    },
  ],
  baseUrlField: {
    file: "providers",
    path: ["providers", SLOT, "settings", "baseUrl"],
  },
  efforts: ["none", "low", "medium", "high", "xhigh"],
  settings(target) {
    const baseUrl = `${target.baseUrl}/v1`;
    const models: Record<string, ConfigValue> = {};
    for (const model of withSelected(target.models, target.model))
      models[model.ref] = {
        id: model.ref,
        name: model.ref,
        capabilities: [
          "streaming",
          "tools",
          ...(model.images ? ["images"] : []),
          ...(model.efforts?.length ? ["reasoning"] : []),
        ],
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(outputLimit(model) ? { maxTokens: outputLimit(model)! } : {}),
      };
    return [
      {
        file: "providers",
        path: ["providers", SLOT],
        value: {
          settings: {
            provider: SLOT,
            apiKey: target.keyText,
            model: target.model,
            baseUrl,
            // Cline's own pickers write no thinking as enabled: false, and
            // drop an effort beside it.
            ...(target.effort !== undefined
              ? {
                  reasoning:
                    target.effort === "none"
                      ? { enabled: false }
                      : { enabled: true, effort: target.effort },
                }
              : {}),
          },
          tokenSource: "manual",
        },
      },
      { file: "providers", path: ["lastUsedProvider"], value: SLOT },
      {
        file: "models",
        path: ["providers", SLOT],
        value: {
          provider: {
            name: "HarnessHub",
            baseUrl,
            defaultModelId: target.model,
          },
          models,
        },
      },
    ];
  },
};

function clineFile(
  environment: AdapterEnvironment,
  name: string,
): FileLocation {
  const data = environment.directory("CLINE_DATA_DIR");
  const home = environment.directory("CLINE_DIR");
  const file = path.join(
    data ?? path.join(home ?? path.join(environment.home, ".cline"), "data"),
    "settings",
    name,
  );
  return {
    candidates: [file],
    create: file,
    root: data ?? home ?? environment.home,
  };
}
