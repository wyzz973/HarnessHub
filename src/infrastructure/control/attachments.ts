import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { ContentRef, ControlAttachment } from "../../contracts/content.js";
import type { NativeInputs } from "../../contracts/control.js";
import { ControlError } from "./json-rpc-process.js";

const KIND_LABEL: Readonly<Record<ContentRef["kind"], string>> = { image: "图片", audio: "音频", file: "文件" };

/**
 * Refuses attachments the declared native inputs cannot take, before anything is sent. Messages are Hub-authored and
 * name only the attachment, so the Runtime can show them to the user.
 */
export function checkInputs(attachments: readonly ContentRef[], inputs: NativeInputs, limits: { readonly image?: number; readonly audio?: number } = {}): void {
  for (const item of attachments) {
    if (!inputs[item.kind]) throw new ControlError("ATTACHMENT_UNSUPPORTED", `当前 Harness 或模型不接受${KIND_LABEL[item.kind]}附件：${item.name}`);
    const limit = item.kind === "image" ? limits.image : item.kind === "audio" ? limits.audio : undefined;
    if (limit !== undefined && item.bytes > limit) throw new ControlError("ATTACHMENT_LIMIT", `${KIND_LABEL[item.kind]}附件超过当前 Harness 的 ${Math.floor(limit / 1000 / 1000)} MB 上限：${item.name}`);
  }
}

/** Reads a private attachment copy exactly; a changed size is a storage fault, never a partial prompt. */
export async function readAttachment(file: ControlAttachment): Promise<Buffer> {
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const data = await handle.readFile();
    if (data.byteLength !== file.bytes) throw new ControlError("ATTACHMENT_CHANGED", "attachment copy changed before dispatch");
    return data;
  } finally { await handle.close(); }
}

/** Plain-text pointer for interfaces without a file input type; the Harness reads the read-only copy with its own tools. */
export function fileMentions(files: readonly ControlAttachment[]): string {
  if (!files.length) return "";
  return "\n\n" + files.map(file => `[Attached file] ${file.name} (${file.mediaType}, ${file.bytes} bytes, read-only copy): ${file.path}`).join("\n");
}
