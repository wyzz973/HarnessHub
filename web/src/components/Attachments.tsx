import { AudioLines, FileText, Image, LoaderCircle, TriangleAlert, X } from "lucide-react";
import type { ContentRef } from "../../../src/contracts/content.js";
import type { NativeInputs } from "../../../src/contracts/control.js";
import { contentUrl } from "../api.js";

/** A file the user added to the next message. Only `ready` items carry a server reference that can be sent. */
export interface AttachmentDraft {
  readonly local: string;
  readonly name: string;
  readonly bytes: number;
  readonly kind: ContentRef["kind"];
  readonly status: "uploading" | "ready" | "failed";
  readonly ref?: ContentRef;
  readonly error?: string;
}
export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const AUDIO_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/ogg", "audio/webm", "audio/flac"]);
const KIND_LABEL: Readonly<Record<ContentRef["kind"], string>> = { image: "图片", audio: "音频", file: "文件" };

/** The server decides the final kind from the bytes; this is the same mapping for its declared type. */
export function attachmentKind(type: string): ContentRef["kind"] {
  const base = type.split(";", 1)[0]!.trim().toLowerCase();
  return IMAGE_TYPES.has(base) ? "image" : AUDIO_TYPES.has(base) ? "audio" : "file";
}
/** Why the current selection cannot take this attachment, or null. Unknown inputs are left to the Harness to decide. */
export function attachmentProblem(item: Pick<AttachmentDraft, "kind">, inputs: NativeInputs | undefined): string | null {
  return inputs !== undefined && !inputs[item.kind] ? `当前 Harness 或模型不接受${KIND_LABEL[item.kind]}` : null;
}
function size(bytes: number): string { return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + " MB" : bytes >= 1024 ? Math.ceil(bytes / 1024) + " KB" : bytes + " B"; }
function KindIcon({ kind }: { kind: ContentRef["kind"] }) {
  return kind === "image" ? <Image size={13} aria-hidden="true"/> : kind === "audio" ? <AudioLines size={13} aria-hidden="true"/> : <FileText size={13} aria-hidden="true"/>;
}

export function ComposerAttachments({ items, inputs, disabled, onRemove }: { items: readonly AttachmentDraft[]; inputs: NativeInputs | undefined; disabled: boolean; onRemove: (local: string) => void }) {
  return <ul className="composer-attachments" aria-label="待发送的附件">{items.map(item => {
    const problem = item.status === "failed" ? item.error ?? "上传失败" : attachmentProblem(item, inputs);
    return <li key={item.local} className={`attachment-chip ${problem ? "is-error" : ""}`} title={problem ?? item.name}>
      {item.status === "uploading" ? <LoaderCircle size={13} className="spin" aria-label="正在上传"/> : problem ? <TriangleAlert size={13} aria-hidden="true"/> : <KindIcon kind={item.kind}/>}
      {item.status === "ready" && item.kind === "image" && item.ref ? <img src={contentUrl(item.ref)} alt="" className="attachment-thumb"/> : null}
      <span className="attachment-name">{item.name}</span>
      <small>{problem ?? (item.status === "uploading" ? "上传中" : size(item.bytes))}</small>
      <button type="button" className="icon-button" aria-label={`移除附件 ${item.name}`} disabled={disabled} onClick={() => onRemove(item.local)}><X size={12}/></button>
    </li>;
  })}</ul>;
}

/** Attachments shown with the user message they were sent with; images open in a new tab, other files download. */
export function MessageAttachments({ attachments }: { attachments: readonly ContentRef[] }) {
  return <div className="message-attachments">{attachments.map(item => item.kind === "image"
    ? <a key={item.id} className="message-attachment-image" href={contentUrl(item)} target="_blank" rel="noopener noreferrer" title={item.name}><img src={contentUrl(item)} alt={item.name} loading="lazy"/></a>
    : <a key={item.id} className="attachment-chip" href={contentUrl(item, true)} download={item.name} title={item.name}><KindIcon kind={item.kind}/><span className="attachment-name">{item.name}</span><small>{size(item.bytes)}</small></a>)}</div>;
}
