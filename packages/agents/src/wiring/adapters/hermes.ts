// SPDX-License-Identifier: MIT
import { overridable, withSelected, type WiringAdapter } from "./types.js";

/**
 * Hermes Agent (Nous Research) reads `config.yaml` in
 * `${HERMES_HOME:-~/.hermes}`. A `harnesshub` entry of `providers` speaks
 * Chat Completions to `<gateway>/v1` with the key as `api_key` and lists the
 * gateway's model refs; `model.provider` selects it and `model.default`
 * holds the ref (Magpie's `hermes.go`). Magpie's `extra_headers` User-Agent
 * is left out: the agent-scoped key already names the caller.
 */
export const hermes: WiringAdapter = {
  id: "hermes",
  name: "Hermes Agent",
  protocol: "chat",
  keyDelivery: "config-file",
  executables: ["hermes"],
  files: [
    {
      id: "config",
      format: "yaml",
      locate: (e) =>
        overridable(e, "HERMES_HOME", [".hermes"], ["config.yaml"]),
    },
  ],
  baseUrlField: {
    file: "config",
    path: ["providers", "harnesshub", "base_url"],
  },
  efforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
  settings(target) {
    return [
      {
        file: "config",
        path: ["providers", "harnesshub"],
        value: {
          name: "HarnessHub",
          base_url: `${target.baseUrl}/v1`,
          api_key: target.keyText,
          api_mode: "chat_completions",
          models: withSelected(target.models, target.model).map(
            (model) => model.ref,
          ),
        },
      },
      { file: "config", path: ["model", "provider"], value: "harnesshub" },
      { file: "config", path: ["model", "default"], value: target.model },
      // What Hermes's /reasoning saves; none turns reasoning off.
      ...(target.effort !== undefined
        ? [
            {
              file: "config",
              path: ["agent", "reasoning_effort"],
              value: target.effort,
            },
          ]
        : []),
    ];
  },
};
