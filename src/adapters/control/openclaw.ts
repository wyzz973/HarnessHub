import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import type { ControlLaunch, ControlOptions, NativeConversationId, NativeModelCatalog, NativeOptions, CleanupEvidence } from "../../contracts/control.js";
import { AcpControl } from "./acp.js";
import { ControlError, object } from "../../infrastructure/control/json-rpc-process.js";
import { nativeCommand } from "../../infrastructure/control/native-command.js";
import { string } from "../../infrastructure/control/json-rpc-process.js";
import { checkInputs } from "../../infrastructure/control/attachments.js";
import type { ContentRef } from "../../contracts/content.js";

/** The installed OpenClaw bridge accepts sessionKey in _meta. A normal chat key avoids its ACP-runtime namespace. */
export class OpenClawControl extends AcpControl {
  private configuredModel: string | null = null;
  /** Session-local model applied with sessions.patch; otherwise the agent's configured model runs. */
  private openedModel: string | undefined;
  private sessionKey: string | null = null;
  private restoredKey: string | null = null;
  private readonly abort = new AbortController();
  private readonly commands = new Set<Promise<unknown>>();
  private nativeModels: Promise<NativeModelCatalog["models"]> | null = null;
  constructor(private readonly nativeLaunch: ControlLaunch, private readonly nativeOptions: ControlOptions,
    private readonly nativeRequest?: (method: "models.list" | "sessions.patch", params: Readonly<Record<string, unknown>>) => Promise<unknown>) { super(nativeLaunch, nativeOptions); }
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
    this.sessionKey = this.restoredKey ?? "agent:" + agent.toLowerCase() + ":harnesshub:" + randomUUID();
    return { ...await super.sessionParameters(cwd), _meta: { sessionKey: this.sessionKey, ...(this.restoredKey === null ? {} : { requireExistingSession: true, resetSession: false }) } };
  }
  private call(method: "models.list" | "sessions.patch", params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.nativeRequest) return this.nativeRequest(method, params);
    const index = this.nativeLaunch.args.lastIndexOf("acp");
    if (index < 0) return Promise.reject(new ControlError("UNSUPPORTED_CONTROL", "OpenClaw native CLI prefix unavailable"));
    const pending = nativeCommand(this.nativeLaunch, [...this.nativeLaunch.args.slice(0, index), "gateway", "call", method, "--json", "--params", JSON.stringify(params)], this.nativeOptions, this.abort.signal).then(value => { let parsed: unknown; try { parsed=JSON.parse(value); } catch { throw new ControlError("INVALID_NATIVE_METADATA","native CLI returned invalid JSON"); } return parsed; });
    this.commands.add(pending); void pending.finally(() => this.commands.delete(pending)).catch(() => {}); return pending;
  }
  private readNativeModels(): Promise<NativeModelCatalog["models"]> {
    this.nativeModels ??= this.call("models.list", {}).then(value => {
      const data = object(value, "OpenClaw native models");
      if (!Array.isArray(data.models) || data.models.length > 4096) throw new ControlError("INVALID_PROTOCOL", "invalid OpenClaw model catalog");
      const models = data.models.map(value => {
        const row = object(value, "OpenClaw model"), provider = string(row.provider, "model provider", 128), id = string(row.id, "model identity", 768);
        if (row.input !== undefined && (!Array.isArray(row.input) || row.input.length > 16 || row.input.some(item => typeof item !== "string"))) throw new ControlError("INVALID_PROTOCOL", "invalid OpenClaw model input kinds");
        // The bridge forwards only images as attachments (audio is dropped); a model without image input would answer without seeing it.
        return { id: provider + "/" + id, name: string(row.name, "model name", 1024), ...(Array.isArray(row.input) ? { inputs: { image: row.input.includes("image"), audio: false, file: true } } : {}) };
      });
      if (new Set(models.map(row => row.id)).size !== models.length) throw new ControlError("INVALID_PROTOCOL", "duplicate OpenClaw models");
      return models;
    });
    return this.nativeModels;
  }
  /** OpenClaw's Gateway drops image attachments above 5,000,000 bytes with only a log line; refuse them up front instead. */
  protected override get maxInlineImageBytes(): number { return 5_000_000; }
  override async checkpoint(): Promise<string | null> {
    const conversation = await super.checkpoint();
    return conversation !== null && this.sessionKey !== null ? JSON.stringify({ conversation, key: this.sessionKey }) : null;
  }
  override async open(cwd: string, model?: string, options?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    let conversation: string | undefined;
    if (checkpoint !== undefined) {
      let parsed: unknown; try { parsed = JSON.parse(checkpoint); } catch { throw new ControlError("INVALID_CHECKPOINT", "invalid native recovery reference"); }
      const value = object(parsed, "OpenClaw recovery reference");
      if (Object.keys(value).some(key => !["conversation", "key"].includes(key)) || typeof value.key !== "string" || !/^agent:[a-z0-9_-]+:harnesshub:[a-f0-9-]+$/u.test(value.key)) throw new ControlError("INVALID_CHECKPOINT", "native key is not a Hub-owned conversation");
      this.restoredKey = value.key; conversation = string(value.conversation, "native conversation");
    }
    const id = await super.open(cwd, undefined, options, conversation);
    if (model !== undefined) {
      if (!(await this.readNativeModels()).some(row => row.id === model)) throw new ControlError("MODEL_UNAVAILABLE", "model unavailable in original OpenClaw catalog");
      if (this.sessionKey === null || !/^agent:[a-z0-9_-]+:harnesshub:[a-f0-9-]+$/u.test(this.sessionKey)) throw new ControlError("IDENTITY_MISMATCH", "OpenClaw session override has no owned key");
      const patched = object(await this.call("sessions.patch", { key: this.sessionKey, model }), "OpenClaw model override");
      const resolved = object(patched.resolved, "OpenClaw resolved model");
      if (resolved.modelProvider + "/" + resolved.model !== model) throw new ControlError("MODEL_MISMATCH", "OpenClaw did not apply the selected session model");
      this.openedModel = model;

    }
    return id;
  }
  /** Agent-level checks first, then the running model's own input kinds from the original catalog when it lists them. */
  override async checkAttachments(attachments: readonly ContentRef[]): Promise<void> {
    await super.checkAttachments(attachments);
    if (!attachments.some(item => item.kind === "image")) return;
    const model = this.openedModel ?? this.configuredModel, entry = (await this.readNativeModels()).find(row => row.id === model);
    if (entry?.inputs) checkInputs(attachments, entry.inputs);
  }
  override async models(): Promise<NativeModelCatalog> {
    const catalog = await super.models();
    const models = await this.readNativeModels();
    return { ...catalog, defaultModel: this.configuredModel, models, canSelect: models.length > 0 };
  }
  override async close(): Promise<CleanupEvidence> { this.abort.abort(); const commands = [...this.commands]; const results = await Promise.allSettled(commands); const cleanup = await super.close(); const failed = results.find(result => result.status === "rejected" && result.reason instanceof ControlError && result.reason.code === "CLEANUP_FAILED"); if (failed?.status === "rejected") throw failed.reason; return cleanup; }
}
