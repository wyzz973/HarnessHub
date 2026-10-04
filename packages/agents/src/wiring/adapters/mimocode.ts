// SPDX-License-Identifier: MIT
import path from "node:path";
import { opencode } from "./opencode.js";
import type {
  AdapterEnvironment,
  FileLocation,
  WiringAdapter,
} from "./types.js";

/**
 * MiMo Code (the `mimo` CLI and the engine of the Xiaomi MiMo desktop app)
 * is a fork of OpenCode that keeps its configuration shape, so it gets the
 * same `harnesshub` provider and `model`/`small_model` entries. It reads the
 * first of `mimocode.jsonc`, `mimocode.json` and `config.json` in
 * `$MIMOCODE_HOME/config`, else in `${XDG_CONFIG_HOME:-~/.config}/mimocode`
 * (Magpie's `mimocode`, agents.go).
 */
export const mimocode: WiringAdapter = {
  ...opencode,
  id: "mimocode",
  name: "MiMo Code",
  executables: ["mimo"],
  files: [{ id: "config", format: "json", locate: mimoCodeFile }],
};

function mimoCodeFile(environment: AdapterEnvironment): FileLocation {
  const home = environment.directory("MIMOCODE_HOME");
  const config = environment.directory("XDG_CONFIG_HOME");
  const directory =
    home !== undefined
      ? path.join(home, "config")
      : path.join(config ?? path.join(environment.home, ".config"), "mimocode");
  return {
    candidates: ["mimocode.jsonc", "mimocode.json", "config.json"].map((name) =>
      path.join(directory, name),
    ),
    create: path.join(directory, "mimocode.json"),
    root: home ?? config ?? environment.home,
  };
}
