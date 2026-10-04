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

/**
 * OpenCode reads `opencode.json` and `opencode.jsonc` (the latter wins) in
 * `${XDG_CONFIG_HOME:-~/.config}/opencode`, and additionally the directory in
 * OPENCODE_CONFIG_DIR, whose files override the global ones; wiring edits
 * that directory when it is set. A `harnesshub` provider uses the bundled
 * OpenAI-compatible SDK with the key in its options (OpenCode 1.1 sent an
 * `{env:...}` reference verbatim). Each model carries, as Magpie writes it:
 * `limit` once the window is known (an unknown output is 0, OpenCode's own
 * default), `attachment` and `modalities` for image input, and `variants`
 * with one entry per reasoning level asking for that `reasoningEffort`; a
 * model without levels gets none, as OpenCode 2 would otherwise offer low,
 * medium and high.
 */
export const opencode: WiringAdapter = {
  id: "opencode",
  name: "OpenCode",
  protocol: "chat",
  keyDelivery: "config-file",
  executables: ["opencode"],
  files: [{ id: "config", format: "json", locate: openCodeFile }],
  baseUrlField: {
    file: "config",
    path: ["provider", "harnesshub", "options", "baseURL"],
  },
  settings(target) {
    const models: Record<string, ConfigValue> = {};
    for (const model of withSelected(target.models, target.model))
      models[model.ref] = {
        name: model.ref,
        ...(model.images
          ? {
              attachment: true,
              modalities: { input: ["text", "image"], output: ["text"] },
            }
          : {}),
        ...(model.contextWindow
          ? {
              limit: {
                context: model.contextWindow,
                output: outputLimit(model) ?? 0,
              },
            }
          : {}),
        variants: Object.fromEntries(
          (model.efforts ?? []).map((effort) => [
            effort,
            { reasoningEffort: effort },
          ]),
        ),
      };
    const selection = `harnesshub/${target.model}`;
    return [
      {
        file: "config",
        path: ["provider", "harnesshub"],
        value: {
          name: "HarnessHub",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `${target.baseUrl}/v1`, apiKey: target.keyText },
          models,
        },
      },
      { file: "config", path: ["model"], value: selection },
      { file: "config", path: ["small_model"], value: selection },
    ];
  },
};

function openCodeFile(environment: AdapterEnvironment): FileLocation {
  const override = environment.directory("OPENCODE_CONFIG_DIR");
  const config = environment.directory("XDG_CONFIG_HOME");
  const directory =
    override ??
    path.join(config ?? path.join(environment.home, ".config"), "opencode");
  return {
    candidates: [
      path.join(directory, "opencode.jsonc"),
      path.join(directory, "opencode.json"),
    ],
    create: path.join(directory, "opencode.json"),
    root: override ?? config ?? environment.home,
  };
}
