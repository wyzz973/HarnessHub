import type { NativeConversationId, NativeModelCatalog, NativeOptions } from "../../contracts/control.js";
import { ControlError } from "../../infrastructure/control/json-rpc-process.js";
import { AcpControl } from "./acp.js";

const GLOBAL_MODEL_SWITCH = { code: "NATIVE_MODEL_SWITCH_GLOBAL", message: "Cursor 会把原生模型选择写成它的全局默认模型；HarnessHub 不代为修改。请在 Cursor 中设置默认模型，这里沿用它。" } as const;
/**
 * Cursor's ACP model option persists the choice as the user's global CLI default (cli-config selectedModel) and applies
 * it to every session in the process; its mode option is session-scoped. The catalog stays readable, model writes never run.
 */
export class CursorControl extends AcpControl {
  override async open(cwd: string, model?: string, options?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    if (model !== undefined) throw new ControlError(GLOBAL_MODEL_SWITCH.code, GLOBAL_MODEL_SWITCH.message);
    return super.open(cwd, undefined, options, checkpoint);
  }
  override async models(): Promise<NativeModelCatalog> {
    return { ...await super.models(), canSelect: false, selectionError: GLOBAL_MODEL_SWITCH };
  }
}
