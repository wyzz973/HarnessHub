// SPDX-License-Identifier: MIT
import path from "node:path";
import { pi } from "./pi.js";
import type {
  AdapterEnvironment,
  FileLocation,
  WiringAdapter,
} from "./types.js";

/**
 * OmO (oh-my-openagent, a fork of Pi on the senpi engine) keeps Pi's
 * `settings.json` and `models.json` in an agent directory of its own:
 * `$OMO_CODING_AGENT_DIR`, else `$SENPI_CODING_AGENT_DIR`, else
 * `~/.omo/agent`. It is wired as Pi is (Magpie's `omo.go`). OmO also reads
 * PI_CODING_AGENT_DIR after its own two; a directory it shares with Pi is
 * wired through the `pi` adapter.
 */
export const omo: WiringAdapter = {
  ...pi,
  id: "omo",
  name: "OmO",
  executables: ["omo"],
  files: [
    {
      id: "settings",
      format: "json",
      locate: (e) => omoFile(e, "settings.json"),
    },
    { id: "models", format: "json", locate: (e) => omoFile(e, "models.json") },
  ],
};

function omoFile(environment: AdapterEnvironment, name: string): FileLocation {
  const override =
    environment.directory("OMO_CODING_AGENT_DIR") ??
    environment.directory("SENPI_CODING_AGENT_DIR");
  const file = path.join(
    override ?? path.join(environment.home, ".omo", "agent"),
    name,
  );
  return {
    candidates: [file],
    create: file,
    root: override ?? environment.home,
  };
}
