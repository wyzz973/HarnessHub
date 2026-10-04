// SPDX-License-Identifier: MIT
import path from "node:path";
import { thinkingLevels } from "./pi.js";
import { outputLimit, withSelected, type WiringAdapter } from "./types.js";

/** Pi's defaults for a model whose window or output cap is unknown. */
const DEFAULT_WINDOW = 128_000;
const DEFAULT_OUTPUT = 16_384;

/**
 * Pencil (pen.dev, the design canvas with an agent) reads custom providers
 * from `~/.pencil/models.json` in Pi's format. A `harnesshub` provider puts
 * every gateway model in Pencil's model picker on Chat Completions at
 * `<gateway>/v1` (Pencil sets the API per provider, not per model), each
 * with the fields Pencil writes for one, its reasoning, image input and Pi's
 * thinking-level map as for Pi, Pi's defaults for an unknown window
 * or output cap and zero cost, the gateway counting spend itself. The model
 * is chosen in Pencil's composer, not in a file, so no selection is written
 * (Magpie's `pencil.go`). Pencil has no command of its own on PATH.
 */
export const pencil: WiringAdapter = {
  id: "pencil",
  name: "Pencil",
  protocol: "chat",
  keyDelivery: "config-file",
  executables: [],
  files: [
    {
      id: "models",
      format: "json",
      locate: ({ home }) => {
        const file = path.join(home, ".pencil", "models.json");
        return { candidates: [file], create: file, root: home };
      },
    },
  ],
  baseUrlField: {
    file: "models",
    path: ["providers", "harnesshub", "baseUrl"],
  },
  settings(target) {
    return [
      {
        file: "models",
        path: ["providers", "harnesshub"],
        value: {
          name: "HarnessHub",
          baseUrl: `${target.baseUrl}/v1`,
          api: "openai-completions",
          apiKey: target.keyText,
          models: withSelected(target.models, target.model).map((model) => {
            const window = model.contextWindow ?? DEFAULT_WINDOW;
            const efforts = model.efforts ?? [];
            return {
              id: model.ref,
              name: model.ref,
              reasoning: efforts.length > 0,
              input: model.images ? ["text", "image"] : ["text"],
              ...(efforts.length
                ? { thinkingLevelMap: thinkingLevels(efforts) }
                : {}),
              contextWindow: window,
              maxTokens: outputLimit(model) ?? Math.min(DEFAULT_OUTPUT, window),
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              compat: {},
            };
          }),
        },
      },
    ];
  },
};
