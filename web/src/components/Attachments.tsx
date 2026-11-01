import { AudioLines, FileText, Image, TriangleAlert, X } from "lucide-react";
import type { ContentRef } from "../../../src/contracts/content.js";
import type { NativeInputs } from "../../../src/contracts/control.js";
import { contentUrl } from "../api.js";
import { cn } from "../lib/cn.js";
import { bytes } from "../lib/format.js";
import { Spinner } from "../ui/primitives.js";

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
function KindIcon({ kind }: { kind: ContentRef["kind"] }) {
  return kind === "image" ? <Image size={13} aria-hidden="true"/> : kind === "audio" ? <AudioLines size={13} aria-hidden="true"/> : <FileText size={13} aria-hidden="true"/>;
}
/** A file as a small grey chip (radius 8): kind or preview, name, size; amber when it cannot go with this message, red when its upload failed. */
const CHIP = "attachment-chip inline-flex h-8 max-w-[260px] min-w-0 items-center gap-1.5 rounded-row bg-subtle pr-1 pl-2 text-caption text-fg";

/** The files staged for the next message, inside the composer above the text. Each can be removed until it is sent. */
export function ComposerAttachments({ items, inputs, disabled, onRemove }: { items: readonly AttachmentDraft[]; inputs: NativeInputs | undefined; disabled: boolean; onRemove: (local: string) => void }) {
  return <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="待发送的附件">{items.map(item => {
    const failed = item.status === "failed", problem = failed ? item.error ?? "上传失败" : attachmentProblem(item, inputs);
    return <li key={item.local} className={cn(CHIP, "motion-fade-in", problem ? cn("is-error", failed ? "bg-red-soft" : "bg-amber-soft") : null)} title={problem ?? item.name}>
      {item.status === "uploading" ? <Spinner size={13} label="正在上传"/> : problem ? <TriangleAlert size={13} className={failed ? "text-red" : "text-amber"} aria-hidden="true"/> : <span className="flex text-fg-3"><KindIcon kind={item.kind}/></span>}
      {item.status === "ready" && item.kind === "image" && item.ref ? <img src={contentUrl(item.ref)} alt="" className="h-5 w-5 flex-none rounded-[4px] object-cover"/> : null}
      <span className="min-w-0 truncate">{item.name}</span>
      <small className={cn("flex-none text-caption", problem ? failed ? "text-red" : "text-amber" : "text-fg-3")}>{problem ?? (item.status === "uploading" ? "上传中" : bytes(item.bytes))}</small>
      <button type="button" className="icon-btn icon-btn-sm h-6 w-6 rounded-tag" aria-label={`移除附件 ${item.name}`} disabled={disabled} onClick={() => onRemove(item.local)}><X size={12}/></button>
    </li>;
  })}</ul>;
}

/** Attachments shown with the user message they were sent with; images open in a new tab, other files download. */
export function MessageAttachments({ attachments, align = "end" }: { attachments: readonly ContentRef[]; align?: "start" | "end" }) {
  return <div className={cn("flex flex-wrap gap-1.5", align === "end" ? "justify-end" : "justify-start")}>{attachments.map(item => item.kind === "image"
    ? <a key={item.id} className="message-attachment-image block overflow-hidden rounded-block shadow-hairline" href={contentUrl(item)} target="_blank" rel="noopener noreferrer" title={item.name}><img className="block max-h-48 max-w-[240px] object-cover" src={contentUrl(item)} alt={item.name} loading="lazy"/></a>
    : <a key={item.id} className={cn(CHIP, "pr-2.5 no-underline transition-[color,background-color] duration-120 ease-standard hover:bg-hover hover:no-underline")} href={contentUrl(item, true)} download={item.name} title={item.name}><span className="flex text-fg-3"><KindIcon kind={item.kind}/></span><span className="min-w-0 truncate">{item.name}</span><small className="text-fg-3">{bytes(item.bytes)}</small></a>)}</div>;
}
