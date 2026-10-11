import type { ControlLaunch, ControlOptions, HarnessControl, NativeModelCatalog } from "../../contracts/control.js";
import { AcpControl } from "./acp.js";
import { CodexControl } from "./codex.js";
import { bindNativeDependencies } from "./native-dependencies.js";
import { PiControl } from "./pi.js";

export { OpenClawControl } from "./openclaw.js";
import { OpenClawControl } from "./openclaw.js";
import { CursorControl } from "./cursor.js";
import { OpenCodeControl } from "./opencode.js";
import { ClaudeControl } from "./claude.js";
import { HermesControl } from "./hermes.js";

/** Vendor extensions remain in the adapter layer; Gateway owns only the common control contract. */
export async function createNativeControl(harnessId: string, launch: ControlLaunch, options: ControlOptions): Promise<HarnessControl> {
  launch = await bindNativeDependencies(harnessId, launch);
  if (launch.protocol === "pi-rpc") return new PiControl(launch, options);
  if (launch.protocol === "codex-app-server") return new CodexControl(launch, options);
  return harnessId === "openclaw" ? new OpenClawControl(launch, options) : harnessId === "cursor" ? new CursorControl(launch, options)
    : harnessId === "opencode" ? new OpenCodeControl(launch, options) : harnessId === "claude" ? new ClaudeControl(launch, options)
    : harnessId === "hermes" ? new HermesControl(launch, options) : new AcpControl(launch, options);
}
