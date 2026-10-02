// SPDX-License-Identifier: MIT
import {
  overridable,
  type AdapterSetting,
  type WiringAdapter,
} from "./types.js";

/**
 * Qwen Code reads `settings.json` and `.env` in `${QWEN_HOME:-~/.qwen}`
 * (QWEN_HOME as HarnessHub's isolated wiring uses it). The settings select
 * the OpenAI auth type, the model and its known limits; the OpenAI-compatible
 * endpoint, key and model go to the dotenv file the CLI loads itself.
 */
export const qwen: WiringAdapter = {
  id: "qwen",
  name: "Qwen Code",
  protocol: "chat",
  keyDelivery: "env-file",
  executables: ["qwen"],
  files: [
    {
      id: "settings",
      format: "json",
      locate: (e) => overridable(e, "QWEN_HOME", [".qwen"], ["settings.json"]),
    },
    {
      id: "env",
      format: "dotenv",
      locate: (e) => overridable(e, "QWEN_HOME", [".qwen"], [".env"]),
    },
  ],
  baseUrlField: { file: "env", path: ["OPENAI_BASE_URL"] },
  settings(target) {
    const { contextWindow, maxOutputTokens } = target.selected ?? {};
    const generation = (path: string[], value: number): AdapterSetting => ({
      file: "settings",
      path: ["model", "generationConfig", ...path],
      value,
    });
    return [
      {
        file: "settings",
        path: ["security", "auth", "selectedType"],
        value: "openai",
      },
      { file: "settings", path: ["model", "name"], value: target.model },
      ...(contextWindow
        ? [generation(["contextWindowSize"], contextWindow)]
        : []),
      ...(maxOutputTokens
        ? [generation(["samplingParams", "max_tokens"], maxOutputTokens)]
        : []),
      { file: "env", path: ["OPENAI_BASE_URL"], value: `${target.baseUrl}/v1` },
      { file: "env", path: ["OPENAI_API_KEY"], value: target.keyText },
      { file: "env", path: ["OPENAI_MODEL"], value: target.model },
    ];
  },
};
