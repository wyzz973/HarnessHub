// SPDX-License-Identifier: MIT
import path from "node:path";
import { getPath } from "../formats/values.js";
import { keyPathV1 } from "./key-path.js";
import type {
  AdapterEnvironment,
  AdapterSetting,
  FileLocation,
  WiringAdapter,
} from "./types.js";

/**
 * Muse Code (Meta's `muse` CLI) keeps its settings in
 * `${XDG_CONFIG_HOME:-~/.config}/muse/settings.json`, a file it refuses
 * without `"schema_version": 1`. `endpoint_transport` says where its
 * requests go: `base_url`, whose `/responses` it asks (OpenAI's Responses
 * API), and `auth`, `bearer` for the Meta sign-in's token or `none`.
 * HarnessHub sets it to the gateway with `auth: "none"`, so the Meta token
 * is never sent there, and the key in the base URL's path (ADR 0033), and
 * `model` to the Model Ref. Muse lists its models from `/muse-code/models`
 * on the endpoint's host, which the gateway serves with the models of
 * Muse's key. Muse reads its settings at start-up. Follows Magpie's
 * `muse.go`.
 */
export const muse: WiringAdapter = {
  id: "muse",
  name: "Muse Code",
  protocol: "responses",
  keyDelivery: "config-file",
  executables: ["muse"],
  files: [
    {
      id: "settings",
      format: "json",
      initial: '{\n  "schema_version": 1\n}\n',
      locate: museFile,
    },
  ],
  baseUrlField: {
    file: "settings",
    path: ["endpoint_transport", "base_url"],
  },
  settings(target, files) {
    const settings: AdapterSetting[] = [
      {
        file: "settings",
        path: ["endpoint_transport"],
        value: { base_url: keyPathV1(target), auth: "none" },
      },
      { file: "settings", path: ["model"], value: target.model },
    ];
    // Muse reads no file without its schema version.
    if (getPath(files.current("settings"), ["schema_version"]) === undefined)
      settings.unshift({
        file: "settings",
        path: ["schema_version"],
        value: 1,
      });
    return settings;
  },
};

function museFile(environment: AdapterEnvironment): FileLocation {
  const config = environment.directory("XDG_CONFIG_HOME");
  const file = path.join(
    config ?? path.join(environment.home, ".config"),
    "muse",
    "settings.json",
  );
  return { candidates: [file], create: file, root: config ?? environment.home };
}
