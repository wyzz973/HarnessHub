// SPDX-License-Identifier: MIT
import path from "node:path";
import { reasoningEfforts } from "@harnesshub/core/model-plane";
import { WiringError } from "../errors.js";
import type { ConfigDocument, ConfigValue } from "../formats/index.js";
import { deepEqual, getPath, isRecord } from "../formats/values.js";
import { openCodeFile, openCodeProvider } from "./opencode.js";
import type {
  AdapterEnvironment,
  AdapterSetting,
  FileLocation,
  WiringAdapter,
} from "./types.js";

/** HarnessHub's provider in the OpenCode configuration OpenChamber runs on. */
const PROVIDER = "harnesshub-openchamber";

/**
 * OpenChamber (a desktop, web and VS Code front end for OpenCode) runs an
 * OpenCode of its own on the user's OpenCode configuration and keeps its
 * profile under `$OPENCHAMBER_DATA_DIR`, else `~/.config/openchamber` (not
 * moved by XDG_CONFIG_HOME): `preferences.json`, `{"version": 1, "fields":
 * {"<key>": {"value", "updatedAt"}}}`, and `settings.json`, which builds
 * from before preferences.json read and from which a missing
 * preferences.json is seeded. A new session takes the project's
 * `defaultModel`, then the profile's, before OpenCode's own `model`.
 *
 * HarnessHub adds a provider of its own, `harnesshub-openchamber` with
 * OpenChamber's key, to the OpenCode configuration (the `opencode` adapter's
 * `harnesshub` provider stays separate), and sets the profile's
 * `defaultModel` to `harnesshub-openchamber/<ref>`: in preferences.json
 * when it is there, stamped with the time the value changed, and in
 * settings.json when that file is there or preferences.json is not. The
 * effort is `defaultVariant`, naming one of the variants the provider gives
 * each model per reasoning level; without an effort the variant of the
 * model before is removed, as OpenChamber's own picker does. A
 * preferences.json OpenChamber would not read is refused. Follows Magpie's
 * `openchamber.go`.
 */
export const openchamber: WiringAdapter = {
  id: "openchamber",
  name: "OpenChamber",
  protocol: "chat",
  keyDelivery: "config-file",
  executables: ["openchamber"],
  files: [
    {
      id: "preferences",
      format: "json",
      locate: (environment) => chamberFile(environment, "preferences.json"),
    },
    {
      id: "settings",
      format: "json",
      locate: (environment) => chamberFile(environment, "settings.json"),
    },
    { id: "opencode", format: "json", locate: openCodeFile, shared: true },
  ],
  baseUrlField: {
    file: "opencode",
    path: ["provider", PROVIDER, "options", "baseURL"],
  },
  efforts: [...reasoningEfforts],
  settings(target, files) {
    const profile: Record<string, ConfigValue | undefined> = {
      defaultModel: `${PROVIDER}/${target.model}`,
      defaultVariant: target.effort,
    };
    const preferences = files.exists("preferences");
    const document = files.current("preferences");
    if (
      preferences &&
      (getPath(document, ["version"]) !== 1 ||
        !isRecord(getPath(document, ["fields"])))
    )
      throw new WiringError(
        "WIRING_UNSUPPORTED_STRUCTURE",
        "OpenChamber's preferences.json is not a version 1 preferences file, which OpenChamber does not write to either; fix or remove it first",
        { path: files.path("preferences") },
      );
    const settings: AdapterSetting[] = [
      {
        file: "opencode",
        path: ["provider", PROVIDER],
        value: openCodeProvider(target, "HarnessHub (OpenChamber)"),
      },
    ];
    for (const [key, value] of Object.entries(profile)) {
      if (preferences)
        settings.push(
          value === undefined
            ? { file: "preferences", path: ["fields", key], remove: true }
            : {
                file: "preferences",
                path: ["fields", key],
                value: stamped(document, key, value, target.now),
              },
        );
      if (files.exists("settings") || !preferences)
        settings.push(
          value === undefined
            ? { file: "settings", path: [key], remove: true }
            : { file: "settings", path: [key], value },
        );
    }
    return settings;
  },
};

/** A profile field as OpenChamber saves one: its time kept while the value stays. */
function stamped(
  document: ConfigDocument,
  key: string,
  value: ConfigValue,
  now: Date,
): ConfigValue {
  const current = getPath(document, ["fields", key]);
  const since = getPath(current, ["updatedAt"]);
  return {
    value,
    updatedAt:
      deepEqual(getPath(current, ["value"]), value) &&
      typeof since === "number" &&
      Number.isSafeInteger(since)
        ? since
        : now.getTime(),
  };
}

function chamberFile(
  environment: AdapterEnvironment,
  name: string,
): FileLocation {
  const override = environment.directory("OPENCHAMBER_DATA_DIR");
  const directory =
    override ?? path.join(environment.home, ".config", "openchamber");
  return {
    candidates: [path.join(directory, name)],
    create: path.join(directory, name),
    root: override ?? environment.home,
  };
}
