// SPDX-License-Identifier: MIT
import path from "node:path";
import type {
  AdapterEnvironment,
  FileLocation,
  WiringAdapter,
} from "./types.js";

/**
 * Gemini CLI reads `settings.json` and, when no project `.env` is found
 * first, `.env` in `${GEMINI_CLI_HOME:-~}/.gemini`. The settings select the
 * API-key auth type and the model; the key and the gateway root (Gemini
 * appends `/v1beta/models/...`) go to the dotenv file, which the CLI loads
 * itself. Variables already in the shell environment win over that file.
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
      { file: "env", path: ["GEMINI_API_KEY"], value: target.keyText },
      { file: "env", path: ["GOOGLE_GEMINI_BASE_URL"], value: target.baseUrl },
    ];
  },
};

function geminiFile(
  environment: AdapterEnvironment,
  name: string,
): FileLocation {
  const base = environment.directory("GEMINI_CLI_HOME");
  const file = path.join(base ?? environment.home, ".gemini", name);
  return { candidates: [file], create: file, root: base ?? environment.home };
}
