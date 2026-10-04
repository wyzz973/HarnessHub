// SPDX-License-Identifier: MIT
import path from "node:path";
import type {
  AdapterEnvironment,
  AdapterSetting,
  FileLocation,
  WiringAdapter,
  WiringModel,
} from "./types.js";

/** Gemini CLI assumes this window for every model name it does not know, which a Model Ref is. */
const GEMINI_UNKNOWN_MODEL_WINDOW = 1_048_576;

/**
 * Gemini CLI reads `settings.json` and, when no project `.env` is found
 * first, `.env` in `${GEMINI_CLI_HOME:-~}/.gemini`. The settings select the
 * API-key auth type and the model; the key and the gateway root (Gemini
 * appends `/v1beta/models/...`) go to the dotenv file, which the CLI loads
 * itself. Variables already in the shell environment win over that file.
 * Gemini sizes a model it does not know at 1M tokens, so for a smaller
 * known window `model.compressionThreshold` (a fraction of that 1M) makes it
 * compress at 80% of the model's window, as HarnessHub's isolated Gemini
 * wiring does (which also reserves the output it configures; global wiring
 * configures none). Gemini CLI has no per-model reasoning setting outside
 * its override lists, which wiring leaves alone.
 */
export const gemini: WiringAdapter = {
  id: "gemini",
  name: "Gemini CLI",
  protocol: "gemini",
  keyDelivery: "env-file",
  executables: ["gemini"],
  files: [
    {
      id: "settings",
      format: "json",
      locate: (e) => geminiFile(e, "settings.json"),
    },
    { id: "env", format: "dotenv", locate: (e) => geminiFile(e, ".env") },
  ],
  baseUrlField: { file: "env", path: ["GOOGLE_GEMINI_BASE_URL"] },
  settings(target) {
    return [
      {
        file: "settings",
        path: ["security", "auth", "selectedType"],
        value: "gemini-api-key",
      },
      { file: "settings", path: ["model", "name"], value: target.model },
      ...compression(target.selected),
      { file: "env", path: ["GEMINI_API_KEY"], value: target.keyText },
      { file: "env", path: ["GOOGLE_GEMINI_BASE_URL"], value: target.baseUrl },
    ];
  },
};

function compression(model: WiringModel | undefined): AdapterSetting[] {
  const window = model?.contextWindow;
  if (!window || window >= GEMINI_UNKNOWN_MODEL_WINDOW) return [];
  const compressAt = Math.max(4096, Math.floor(window * 0.8));
  return [
    {
      file: "settings",
      path: ["model", "compressionThreshold"],
      value:
        Math.ceil((compressAt / GEMINI_UNKNOWN_MODEL_WINDOW) * 10_000) / 10_000,
    },
  ];
}

function geminiFile(
  environment: AdapterEnvironment,
  name: string,
): FileLocation {
  const base = environment.directory("GEMINI_CLI_HOME");
  const file = path.join(base ?? environment.home, ".gemini", name);
  return { candidates: [file], create: file, root: base ?? environment.home };
}
