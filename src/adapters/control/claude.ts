import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_CONTENT_BYTES, type ControlAttachment } from "../../contracts/content.js";
import type { BackendResult, ControlEvent, ControlLaunch, ControlOptions, ControlRun, NativeConversationId, NativeModelCatalog } from "../../contracts/control.js";
import { ControlError } from "../../infrastructure/control/json-rpc-process.js";
import { AcpControl } from "./acp.js";

const EXPORT = { name: "export", description: "导出原生会话记录（Claude Code 转录 JSONL）" } as const;
/** Project directories searched for a transcript, as claude-agent-acp itself searches them. */
const MAX_PROJECT_DIRECTORIES = 4096;

/**
 * Claude Code keeps each session's transcript in its configuration directory (`projects/<project>/<session>.jsonl`), where
 * claude-agent-acp itself looks it up; ACP has no export method. When the agent lists no `export` command of its own, the
 * Hub offers `/export`, which copies that transcript read-only as an output of the Run. Nothing is sent to the model.
 */
export class ClaudeControl extends AcpControl {
  private hubExport = false;
  constructor(private readonly claudeLaunch: ControlLaunch, options: ControlOptions) { super(claudeLaunch, options); }
  override async models(): Promise<NativeModelCatalog> {
    const catalog = await super.models();
    this.hubExport = !(catalog.commands ?? []).some(command => command.name === EXPORT.name);
    return this.hubExport ? { ...catalog, commands: [...(catalog.commands ?? []), EXPORT] } : catalog;
  }
  override async startText(id: NativeConversationId, prompt: string, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    if (this.hubExport && !attachments.length && /^\/export\s*$/u.test(prompt)) {
      return { result: this.exportTranscript(id, onEvent), requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "an export has no native turn to stop")) };
    }
    return super.startText(id, prompt, onEvent, attachments);
  }
  private async exportTranscript(id: NativeConversationId, onEvent: (event: ControlEvent) => void): Promise<BackendResult> {
    try {
      if (!/^[A-Za-z0-9-]{1,128}$/u.test(id)) throw new ControlError("NATIVE_EXPORT_UNAVAILABLE", "this Claude session has no transcript name");
      const env = this.claudeLaunch.env, projects = join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "projects");
      let found: string | null = null;
      for (const entry of (await readdir(projects, { withFileTypes: true })).slice(0, MAX_PROJECT_DIRECTORIES)) {
        if (!entry.isDirectory()) continue;
        const candidate = join(projects, entry.name, id + ".jsonl");
        try { if ((await stat(candidate)).isFile()) { found = candidate; break; } }
        catch (error) { if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
      }
      if (found === null) throw new ControlError("NATIVE_EXPORT_UNAVAILABLE", "Claude Code has no transcript for this session");
      const info = await stat(found);
      if (info.size < 1 || info.size > MAX_CONTENT_BYTES) throw new ControlError("NATIVE_EXPORT_UNAVAILABLE", "the Claude Code transcript is empty or exceeds 20 MiB");
      onEvent({ type: "output", output: { kind: "content", name: "claude-" + id + ".jsonl", mediaType: "application/x-ndjson", data: await readFile(found) } });
      return { status: "completed", reason: "exported" };
    } catch (error) {
      const code = error instanceof ControlError ? error.code : "NATIVE_EXPORT_UNAVAILABLE";
      return { status: "failed", reason: "export_failed", error: { code, message: error instanceof ControlError ? error.message : "the Claude Code transcript could not be read" } };
    }
  }
}
