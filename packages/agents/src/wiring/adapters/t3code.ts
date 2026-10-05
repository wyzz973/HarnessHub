// SPDX-License-Identifier: MIT
import { overridable, withSelected, type WiringAdapter } from "./types.js";

/**
 * T3 Code (pingdotgg/t3code, a GUI that drives Claude Code, Codex and others)
 * reads `userdata/settings.json` in `${T3CODE_HOME:-~/.t3}` and reloads it on
 * an outside edit. A provider instance of its own, `harnesshub`, runs Claude
 * Code (driver `claudeAgent`) with ANTHROPIC_BASE_URL at the gateway root and
 * the key as ANTHROPIC_AUTH_TOKEN added to its environment, and lists every
 * gateway model as a custom model; the model is then chosen in T3's picker,
 * so no selection is written (Magpie's `t3code.go`). The variables are
 * written with `sensitive: false` as Magpie does; whether T3 would move a
 * sensitive value out of the file is not verified. Claude Code's own
 * `settings.json` env, applied over the process environment, still wins
 * when it routes elsewhere. T3 Code has no command of its own on PATH.
 */
export const t3code: WiringAdapter = {
  id: "t3code",
  name: "T3 Code",
  restartNotice: null,
  protocol: "anthropic",
  keyDelivery: "config-file",
  executables: [],
  files: [
    {
      id: "settings",
      format: "json",
      locate: (e) =>
        overridable(e, "T3CODE_HOME", [".t3"], ["userdata/settings.json"]),
    },
  ],
  baseUrlField: {
    file: "settings",
    path: ["providerInstances", "harnesshub", "environment"],
  },
  settings(target) {
    return [
      {
        file: "settings",
        path: ["providerInstances", "harnesshub"],
        value: {
          driver: "claudeAgent",
          displayName: "HarnessHub",
          enabled: true,
          environment: [
            {
              name: "ANTHROPIC_BASE_URL",
              value: target.baseUrl,
              sensitive: false,
            },
            {
              name: "ANTHROPIC_AUTH_TOKEN",
              value: target.keyText,
              sensitive: false,
            },
          ],
          config: {
            customModels: withSelected(target.models, target.model).map(
              (model) => ({ slug: model.ref, name: model.ref }),
            ),
          },
        },
      },
    ];
  },
};
