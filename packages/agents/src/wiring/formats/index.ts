// SPDX-License-Identifier: MIT
import { dotenvEditor } from "./dotenv.js";
import { jsonEditor } from "./json.js";
import { tomlEditor } from "./toml.js";
import type { ConfigFormat, FormatEditor } from "./types.js";
import { yamlEditor } from "./yaml.js";

export type {
  ConfigFormat,
  ConfigValue,
  ElementSelector,
  FormatEditor,
  KeyPath,
  PathSegment,
} from "./types.js";

/** The editor of each supported format. */
export const editors: Readonly<Record<ConfigFormat, FormatEditor>> = {
  json: jsonEditor,
  toml: tomlEditor,
  yaml: yamlEditor,
  dotenv: dotenvEditor,
};
