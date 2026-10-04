// SPDX-License-Identifier: MIT
import {
  overridable,
  withSelected,
  type AdapterTarget,
  type AdapterSetting,
  type WiringAdapter,
} from "./types.js";

/**
 * Qoder CLI reads `settings.json` in `${QODER_CONFIG_DIR:-~/.qoder}`; Qoder
 * CN, the same CLI for the China site, in `${QODERCN_CONFIG_DIR:-~/.qoder-cn}`.
 * A `harnesshub` entry of `providers` speaks OpenAI Chat Completions to
 * `<gateway>/v1` with the key as `apiKey` and lists the gateway's models;
 * `model.name` selects `harnesshub/<ref>` (Magpie's `qoder.go`). Qoder
 * offers custom providers only to a signed-in account whose plan includes
 * BYOK; without it the provider is ignored.
 */
export const qoder: WiringAdapter = qoderBuild({
  id: "qoder",
  name: "Qoder",
  variable: "QODER_CONFIG_DIR",
  directory: ".qoder",
  executable: "qodercli",
});

/** Qoder CN: see `qoder`. */
export const qoderCn: WiringAdapter = qoderBuild({
  id: "qoder-cn",
  name: "Qoder CN",
  variable: "QODERCN_CONFIG_DIR",
  directory: ".qoder-cn",
  executable: "qoderclicn",
});

function qoderBuild(build: {
  id: string;
  name: string;
  variable: string;
  directory: string;
  executable: string;
}): WiringAdapter {
  return {
    id: build.id,
    name: build.name,
    protocol: "chat",
    keyDelivery: "config-file",
    executables: [build.executable],
    files: [
      {
        id: "settings",
        format: "json",
        locate: (e) =>
          overridable(e, build.variable, [build.directory], ["settings.json"]),
      },
    ],
    baseUrlField: {
      file: "settings",
      path: ["providers", "harnesshub", "baseUrl"],
    },
    settings: qoderSettings,
  };
}

function qoderSettings(target: AdapterTarget): AdapterSetting[] {
  return [
    {
      file: "settings",
      path: ["providers", "harnesshub"],
      value: {
        displayName: "HarnessHub",
        protocol: "openai",
        baseUrl: `${target.baseUrl}/v1`,
        apiKey: target.keyText,
        model: target.model,
        models: withSelected(target.models, target.model).map((model) => ({
          model: model.ref,
          displayName: model.ref,
          capabilities: { tools: true, vision: false },
          ...(model.contextWindow
            ? { contextWindow: model.contextWindow }
            : {}),
          ...(model.maxOutputTokens
            ? { maxOutputTokens: model.maxOutputTokens }
            : {}),
        })),
      },
    },
    {
      file: "settings",
      path: ["model", "name"],
      value: `harnesshub/${target.model}`,
    },
  ];
}
