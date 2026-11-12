import type { ControlLaunch, ControlOptions, HarnessControl, NativeModelCatalog } from "../../contracts/control.js";
import type { RelayCapabilities } from "../../contracts/relay.js";
import { AcpControl, dshRelayCapabilities } from "./acp.js";
import { DshControl } from "./dsh.js";
import { CodexControl, codexRelayCapabilities } from "./codex.js";
import { bindNativeDependencies } from "./native-dependencies.js";
import { PiControl } from "./pi.js";

export { OpenClawControl } from "./openclaw.js";
import { OpenClawControl, openClawRelayCapabilities } from "./openclaw.js";
import { CursorControl } from "./cursor.js";
import { OpenCodeControl, openCodeRelayCapabilities } from "./opencode.js";
import { ClaudeControl, claudeRelayCapabilities } from "./claude.js";
import { HermesControl, hermesRelayCapabilities } from "./hermes.js";
import { flavorOf } from "../flavors/index.js";

/** A JSON object, or null for anything else. */
function jsonObject(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) return null;
  try { const value: unknown = JSON.parse(text); return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}
function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prior = out[key];
    out[key] = value !== null && typeof value === "object" && !Array.isArray(value) && prior !== null && typeof prior === "object" && !Array.isArray(prior)
      ? deepMerge(prior as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return out;
}
/**
 * The environment the adapter declaration names for the connection's permission level (flavors/<harnessId>.ts, `session.env`), added to the
 * program's own: the level as the Harness's own per-process setting (OpenCode's inline configuration, DeepSeek Harness's preset, Hermes's yolo).
 * A variable the program already has that holds a JSON object (an inline configuration) is merged with the declared one, the level's keys
 * winning, so nothing else it says is dropped. No level, nothing added.
 */
export function levelEnvironment(harnessId: string, launch: ControlLaunch, options: ControlOptions): ControlLaunch {
  const declared = options.permission === undefined ? undefined : flavorOf(harnessId).permission[options.permission].session?.env;
  if (declared === undefined) return launch;
  const env: Record<string, string> = { ...launch.env };
  for (const [name, value] of Object.entries(declared)) {
    const prior = jsonObject(env[name] ?? options.env[name]), mine = jsonObject(value);
    env[name] = prior !== null && mine !== null ? JSON.stringify(deepMerge(prior, mine)) : value;
  }
  return { ...launch, env };
}

/** Vendor extensions remain in the adapter layer; Gateway owns only the common control contract. */
export async function createNativeControl(harnessId: string, launch: ControlLaunch, options: ControlOptions): Promise<HarnessControl> {
  launch = levelEnvironment(harnessId, await bindNativeDependencies(harnessId, launch), options);
  if (launch.protocol === "pi-rpc") return new PiControl(launch, options);
  if (launch.protocol === "codex-app-server") return new CodexControl(launch, options);
  return harnessId === "openclaw" ? new OpenClawControl(launch, options) : harnessId === "cursor" ? new CursorControl(launch, options)
    : harnessId === "opencode" ? new OpenCodeControl(launch, options) : harnessId === "claude" ? new ClaudeControl(launch, options)
    : harnessId === "hermes" ? new HermesControl(launch, options) : harnessId === "dsh" ? new DshControl(launch, options) : new AcpControl(launch, options);
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
