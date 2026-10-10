import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import type { ControlLaunch, ControlOptions, HarnessControl, NativeModelCatalog } from "../../contracts/control.js";
import { AcpControl } from "./acp.js";
import { CodexControl } from "./codex.js";
import { ControlError, object } from "../../infrastructure/control/json-rpc-process.js";

/** The installed OpenClaw bridge accepts sessionKey in _meta. A normal chat key avoids its ACP-runtime namespace. */
export class OpenClawControl extends AcpControl {
  private configuredModel: string | null = null;
  constructor(private readonly nativeLaunch: ControlLaunch, options: ControlOptions) { super(nativeLaunch, options); }
  protected override async sessionParameters(cwd: string): Promise<Readonly<Record<string, unknown>>> {
    const env = this.nativeLaunch.env, path = env.OPENCLAW_CONFIG_PATH ?? join(env.OPENCLAW_STATE_DIR ?? join(env.HOME ?? homedir(), ".openclaw"), "openclaw.json");
    let config: Record<string, unknown>;
    try {
      const info = await stat(path); if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new ControlError("NATIVE_CONFIGURATION_INVALID", "native configuration exceeds its budget");
      const source = await readFile(path, "utf8"); if (Buffer.byteLength(source) > 2 * 1024 * 1024) throw new ControlError("NATIVE_CONFIGURATION_INVALID", "native configuration grew beyond its budget");
      const value: unknown = JSON5.parse(source); config = object(value, "OpenClaw configuration");
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") config = {};
      else throw new ControlError("NATIVE_CONFIGURATION_INVALID", "cannot read the native OpenClaw configuration");
    }
    const agents = config.agents === undefined ? {} : object(config.agents, "native agents");
    const list = agents.list === undefined ? [] : agents.list;
    if (!Array.isArray(list) || list.length > 256) throw new ControlError("NATIVE_CONFIGURATION_INVALID", "invalid native agent catalog");
    const entries = list.map(value => object(value, "native agent"));
    const selected = entries.find(entry => entry.default === true) ?? entries[0];
    const agent = selected?.id ?? "main";
    if (typeof agent !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(agent)) throw new ControlError("NATIVE_CONFIGURATION_INVALID", "invalid native default agent");
    const defaults = agents.defaults === undefined ? {} : object(agents.defaults, "native agent defaults");
    const model = selected?.model ?? defaults.model;
    const primary = typeof model === "string" ? model : model == null ? null : object(model, "native model").primary;
    if (primary != null && (typeof primary !== "string" || !primary.trim() || primary.length > 1024 || /[\0\r\n]/u.test(primary))) throw new ControlError("NATIVE_CONFIGURATION_INVALID", "invalid native configured model");
    this.configuredModel = primary ?? null;
    return { ...await super.sessionParameters(cwd), _meta: { sessionKey: "agent:" + agent.toLowerCase() + ":harnesshub:" + randomUUID() } };
  }
  override async models(): Promise<NativeModelCatalog> {
    const catalog = await super.models();
    if (catalog.canSelect || this.configuredModel === null) return catalog;
    return { ...catalog, defaultModel: this.configuredModel, models: [{ id: this.configuredModel, name: this.configuredModel }] };
  }
}
/** Vendor extensions remain in the adapter layer; Gateway owns only the common control contract. */
export function createNativeControl(harnessId: string, launch: ControlLaunch, options: ControlOptions): HarnessControl {
  if (launch.protocol === "codex-app-server") return new CodexControl(launch, options);
  return harnessId === "openclaw" ? new OpenClawControl(launch, options) : new AcpControl(launch, options);
}
