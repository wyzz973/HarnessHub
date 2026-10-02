// SPDX-License-Identifier: MIT
import path from "node:path";
import {
  withSelected,
  type AdapterEnvironment,
  type FileLocation,
  type WiringAdapter,
} from "./types.js";

/**
 * Crush reads `crush.json` in `${XDG_CONFIG_HOME:-~/.config}/crush`
 * (`%LOCALAPPDATA%\crush` on Windows). A `harnesshub` provider of type
 * `openai-compat` (Crush's type for OpenAI-compatible Chat endpoints; 04
 * names `openai`, which Crush reserves for OpenAI itself) lists the gateway's
 * models, and both model roles select the chosen model.
 */
export const crush: WiringAdapter = {
  id: "crush",
  name: "Crush",
  protocol: "chat",
  keyDelivery: "config-file",
  executables: ["crush"],
  files: [{ id: "config", format: "json", locate: crushFile }],
  baseUrlField: {
    file: "config",
    path: ["providers", "harnesshub", "base_url"],
  },
  settings(target) {
    const selection = { model: target.model, provider: "harnesshub" };
    return [
      {
        file: "config",
        path: ["providers", "harnesshub"],
        value: {
          name: "HarnessHub",
          type: "openai-compat",
          base_url: `${target.baseUrl}/v1`,
          api_key: target.keyText,
          models: withSelected(target.models, target.model).map((model) => ({
            id: model.ref,
            name: model.ref,
            ...(model.contextWindow
              ? { context_window: model.contextWindow }
              : {}),
            ...(model.maxOutputTokens
              ? { default_max_tokens: model.maxOutputTokens }
              : {}),
          })),
        },
      },
      { file: "config", path: ["models", "large"], value: selection },
      { file: "config", path: ["models", "small"], value: selection },
    ];
  },
};

function crushFile(environment: AdapterEnvironment): FileLocation {
  const local =
    environment.platform === "win32"
      ? environment.directory("LOCALAPPDATA")
      : undefined;
  const config = environment.directory("XDG_CONFIG_HOME");
  const directory =
    local !== undefined
      ? path.join(local, "crush")
      : path.join(config ?? path.join(environment.home, ".config"), "crush");
  const file = path.join(directory, "crush.json");
  return {
    candidates: [file],
    create: file,
    root: local ?? config ?? environment.home,
  };
}
