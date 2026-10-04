// SPDX-License-Identifier: MIT
import path from "node:path";
import type {
  AdapterEnvironment,
  FileLocation,
  WiringAdapter,
} from "./types.js";

/** HarnessHub's profile in Desktop's configLibrary: a UUID like Desktop's own, its last part "harnes" in hex. */
export const DESKTOP_PROFILE_ID = "00000000-0000-4000-8000-6861726e6573";

/**
 * Claude Desktop runs on a third-party gateway in its `3p` deployment mode:
 * no Anthropic sign-in, and its Code and Cowork tabs on the gateway's
 * models. As CC Switch and Magpie's `claudedesktop.go` write it:
 *
 * - `Claude-3p/configLibrary/<id>.json` is HarnessHub's profile: the gateway
 *   root, the key as a bearer token, and, unless the profile already sets
 *   them, the deployment-mode chooser hidden and Cowork's egress open
 *   (Desktop's own settings in it are kept).
 * - `Claude-3p/configLibrary/_meta.json` lists the profile as one element of
 *   `entries` and applies it (`appliedId`); other profiles are left alone.
 * - Both `claude_desktop_config.json` files (in `Claude` and `Claude-3p`)
 *   get `deploymentMode: "3p"`, written last so that Desktop starts as
 *   before until everything else is in place.
 *
 * The folders are in `~/Library/Application Support` on macOS,
 * `%LOCALAPPDATA%` on Windows and `${XDG_CONFIG_HOME:-~/.config}` elsewhere.
 * Desktop lists the gateway's `/v1/models` and keeps only ids that read as
 * Anthropic's, so its key lists models by Claude-style aliases
 * (`modelIdStyle: claude-alias`). Unwire restores each mode and the profile
 * applied before. Desktop reads all of this at start-up only.
 */
export const claudeDesktop: WiringAdapter = {
  id: "claude-desktop",
  name: "Claude Desktop",
  protocol: "anthropic",
  keyDelivery: "config-file",
  executables: [],
  modelIdStyle: "claude-alias",
  files: [
    {
      id: "profile",
      format: "json",
      locate: (e) =>
        desktopFile(
          e,
          "Claude-3p",
          "configLibrary",
          `${DESKTOP_PROFILE_ID}.json`,
        ),
    },
    {
      id: "meta",
      format: "json",
      locate: (e) => desktopFile(e, "Claude-3p", "configLibrary", "_meta.json"),
    },
    {
      id: "config3p",
      format: "json",
      locate: (e) => desktopFile(e, "Claude-3p", "claude_desktop_config.json"),
    },
    {
      id: "config",
      format: "json",
      locate: (e) => desktopFile(e, "Claude", "claude_desktop_config.json"),
    },
  ],
  baseUrlField: { file: "profile", path: ["inferenceGatewayBaseUrl"] },
  settings(target, files) {
    // Policies seeded once: what the user set in Desktop since is kept.
    const profile = files.current("profile");
    const chooser = profile.disableDeploymentModeChooser;
    const egress = profile.coworkEgressAllowedHosts;
    return [
      { file: "profile", path: ["inferenceProvider"], value: "gateway" },
      {
        file: "profile",
        path: ["inferenceGatewayBaseUrl"],
        value: target.baseUrl,
      },
      {
        file: "profile",
        path: ["inferenceGatewayApiKey"],
        value: target.keyText,
      },
      {
        file: "profile",
        path: ["inferenceGatewayAuthScheme"],
        value: "bearer",
      },
      {
        file: "profile",
        path: ["disableDeploymentModeChooser"],
        value: typeof chooser === "boolean" ? chooser : true,
      },
      {
        file: "profile",
        path: ["coworkEgressAllowedHosts"],
        value:
          Array.isArray(egress) &&
          egress.every((host) => typeof host === "string")
            ? (egress as string[])
            : ["*"],
      },
      {
        file: "meta",
        path: ["entries", { match: { id: DESKTOP_PROFILE_ID } }],
        value: { id: DESKTOP_PROFILE_ID, name: "HarnessHub" },
      },
      { file: "meta", path: ["appliedId"], value: DESKTOP_PROFILE_ID },
      { file: "config3p", path: ["deploymentMode"], value: "3p" },
      { file: "config", path: ["deploymentMode"], value: "3p" },
    ];
  },
};

function desktopFile(
  environment: AdapterEnvironment,
  folder: string,
  ...names: string[]
): FileLocation {
  let base: string;
  let root = environment.home;
  if (environment.platform === "darwin")
    base = path.join(environment.home, "Library", "Application Support");
  else if (environment.platform === "win32") {
    const local = environment.directory("LOCALAPPDATA");
    base = local ?? path.join(environment.home, "AppData", "Local");
    root = local ?? root;
  } else {
    const config = environment.directory("XDG_CONFIG_HOME");
    base = config ?? path.join(environment.home, ".config");
    root = config ?? root;
  }
  const file = path.join(base, folder, ...names);
  return { candidates: [file], create: file, root };
}
