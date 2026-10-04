// SPDX-License-Identifier: MIT
import { adapterSuite } from "./wiring-suite.js";

// Fixture shapes follow Magpie's agents at 2e340f7; the golden files are
// reviewed output: regenerate them only after reviewing a change to what the
// adapter writes. The key goes in the base URL's path (ADR 0033).
adapterSuite("muse", {
  protocol: "responses",
  executables: ["muse"],
  files: [".config/muse/settings.json"],
  locations: [
    { env: { XDG_CONFIG_HOME: "xdg" }, files: ["xdg/muse/settings.json"] },
  ],
  existing: {
    ".config/muse/settings.json": `{
  "schema_version": 1,
  "theme": "dark",
  "endpoint_transport": { "base_url": "https://api.meta.example/v1", "auth": "bearer" },
  "model": "muse-spark"
}
`,
  },
  golden: {
    empty: {
      ".config/muse/settings.json": `{
  "schema_version": 1,
  "endpoint_transport": {
    "base_url": "http://127.0.0.1:3180/k/hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS/v1",
    "auth": "none"
  },
  "model": "deepseek/deepseek-chat"
}
`,
    },
    existing: {
      ".config/muse/settings.json": `{
  "schema_version": 1,
  "theme": "dark",
  "endpoint_transport": {
    "base_url": "http://127.0.0.1:3180/k/hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS/v1",
    "auth": "none"
  },
  "model": "deepseek/deepseek-chat"
}
`,
    },
  },
  // The user's endpoint is an object wiring replaces.
  restoresByValue: [".config/muse/settings.json"],
});
