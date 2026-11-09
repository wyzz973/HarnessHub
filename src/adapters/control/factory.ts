import type { ControlLaunch, ControlOptions, HarnessControl, NativeModelCatalog } from "../../contracts/control.js";
import type { RelayCapabilities } from "../../contracts/relay.js";
import { AcpControl, dshRelayCapabilities } from "./acp.js";
import { CodexControl, codexRelayCapabilities } from "./codex.js";
import { bindNativeDependencies } from "./native-dependencies.js";
import { PiControl } from "./pi.js";

export { OpenClawControl } from "./openclaw.js";
import { OpenClawControl, openClawRelayCapabilities } from "./openclaw.js";
import { CursorControl } from "./cursor.js";
import { OpenCodeControl, openCodeRelayCapabilities } from "./opencode.js";
import { ClaudeControl, claudeRelayCapabilities } from "./claude.js";
import { HermesControl, hermesRelayCapabilities } from "./hermes.js";

/** Vendor extensions remain in the adapter layer; Gateway owns only the common control contract. */
export async function createNativeControl(harnessId: string, launch: ControlLaunch, options: ControlOptions): Promise<HarnessControl> {
  launch = await bindNativeDependencies(harnessId, launch);
  if (launch.protocol === "pi-rpc") return new PiControl(launch, options);
  if (launch.protocol === "codex-app-server") return new CodexControl(launch, options);
  return harnessId === "openclaw" ? new OpenClawControl(launch, options) : harnessId === "cursor" ? new CursorControl(launch, options)
    : harnessId === "opencode" ? new OpenCodeControl(launch, options) : harnessId === "claude" ? new ClaudeControl(launch, options)
    : harnessId === "hermes" ? new HermesControl(launch, options) : new AcpControl(launch, options, harnessId === "dsh" ? dshRelayCapabilities : undefined);
}

/**
 * The relay declaration of the Driver createNativeControl picks for this harness and protocol (ADR-055 §3.2, F10): the
 * same frozen object that Driver's connections carry as relayCapabilities, read at admission without an instance. Null
 * for a Driver that declares none (Pi, Cursor, and any other Harness on the generic ACP driver), which the relay treats
 * as the most conservative declaration. Synchronous and without I/O.
 */
export function relayCapabilities(harnessId: string, protocol: ControlLaunch["protocol"]): RelayCapabilities | null {
  if (protocol === "pi-rpc") return null;
  if (protocol === "codex-app-server") return codexRelayCapabilities;
  return harnessId === "openclaw" ? openClawRelayCapabilities : harnessId === "opencode" ? openCodeRelayCapabilities : harnessId === "claude" ? claudeRelayCapabilities
    : harnessId === "hermes" ? hermesRelayCapabilities : harnessId === "dsh" ? dshRelayCapabilities : null;
}
