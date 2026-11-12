import { SessionError } from "./session.js";

declare const contentBrand: unique symbol;
export type ContentId = string & { readonly [contentBrand]: true };
export type ContentKind = "image" | "audio" | "file";
export type ContentOrigin = "upload" | "output";
/**
 * What one UPLOAD (an attachment) may hold, checked when it is staged and refused then, so that nothing the user sent is lost after it was accepted; native transport limits are
 * checked again by each Driver. The content a Harness made (a tool call's detail, an artifact) has no such bound: it is kept whole, whatever its size.
 */
export const MAX_CONTENT_BYTES = 20 * 1024 * 1024;
/** User attachments admitted with one input. */
export const MAX_RUN_ATTACHMENTS = 8;
export const MAX_RUN_ATTACHMENT_BYTES = 32 * 1024 * 1024;
export const MAX_CONTENT_NAME_BYTES = 255;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const AUDIO_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/ogg", "audio/webm", "audio/flac"]);
const TEXT_TYPES = new Set(["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/toml", "application/javascript", "application/typescript", "application/x-sh", "application/sql", "application/graphql"]);

export function contentId(value: unknown): ContentId {
  if (typeof value !== "string" || !/^content-[a-zA-Z0-9-]{1,96}$/u.test(value)) throw new SessionError("INVALID_INPUT", "invalid content identity");
  return value as ContentId;
}
/** Display names are labels only: no path separators, controls, or traversal can reach a Driver path. */
export function contentName(value: unknown): string {
  if (typeof value !== "string") throw new SessionError("INVALID_INPUT", "content name must be text");
  const name = value.normalize("NFC").trim();
  if (!name || name === "." || name === ".." || new TextEncoder().encode(name).byteLength > MAX_CONTENT_NAME_BYTES || /[\0-\x1f\x7f/\\]/u.test(name)) throw new SessionError("INVALID_INPUT", "invalid content name");
  return name;
}
export function mediaType(value: unknown): string {
  if (typeof value !== "string") throw new SessionError("INVALID_INPUT", "media type must be text");
  const type = value.split(";", 1)[0]!.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u.test(type)) throw new SessionError("INVALID_INPUT", "invalid media type");
  return type;
}
/** Declared types are accepted as image/audio only when the bytes carry the matching signature. SVG is never an inline image. */
export function contentKind(type: string, head: Uint8Array): ContentKind {
  const starts = (...bytes: number[]) => bytes.every((value, index) => head[index] === value);
  const ascii = (offset: number, text: string) => [...text].every((char, index) => head[offset + index] === char.charCodeAt(0));
  if (IMAGE_TYPES.has(type)) {
    const valid = type === "image/png" ? starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) : type === "image/jpeg" ? starts(0xff, 0xd8, 0xff)
      : type === "image/gif" ? ascii(0, "GIF87a") || ascii(0, "GIF89a") : ascii(0, "RIFF") && ascii(8, "WEBP");
    if (!valid) throw new SessionError("INVALID_INPUT", "image bytes do not match their declared type");
    return "image";
  }
  if (AUDIO_TYPES.has(type)) {
    const valid = type === "audio/wav" || type === "audio/x-wav" ? ascii(0, "RIFF") && ascii(8, "WAVE") : type === "audio/mpeg" ? ascii(0, "ID3") || head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0
      : type === "audio/ogg" ? ascii(0, "OggS") : type === "audio/flac" ? ascii(0, "fLaC") : type === "audio/webm" ? starts(0x1a, 0x45, 0xdf, 0xa3)
      : type === "audio/aac" ? head[0] === 0xff && ((head[1] ?? 0) & 0xf6) === 0xf0 : ascii(4, "ftyp");
    if (!valid) throw new SessionError("INVALID_INPUT", "audio bytes do not match their declared type");
    return "audio";
  }
  return "file";
}
/** Whether a file can be offered to a Harness as UTF-8 text rather than opaque bytes. */
export function textual(type: string): boolean { return type.startsWith("text/") || TEXT_TYPES.has(type) || type.endsWith("+json") || type.endsWith("+xml"); }
/** Immutable public reference; bytes stay in the owner-local content store and never enter Session snapshots or events. */
export interface ContentRef {
  readonly id: ContentId;
  readonly name: string;
  readonly mediaType: string;
  readonly kind: ContentKind;
  readonly bytes: number;
  readonly sha256: string;
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SessionError("INVALID_DATA", label + " must be an object");
  return value as Record<string, unknown>;
}
export function parseContentRef(value: unknown): ContentRef {
  const item = record(value, "content reference");
  if (Object.keys(item).some(key => !["id", "name", "mediaType", "kind", "bytes", "sha256"].includes(key))) throw new SessionError("INVALID_DATA", "content reference has unknown fields");
  try {
    const kind = item.kind;
    if (kind !== "image" && kind !== "audio" && kind !== "file") throw new SessionError("INVALID_DATA", "unknown content kind");
    if (typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes < 0) throw new SessionError("INVALID_DATA", "invalid content size");
    if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(item.sha256)) throw new SessionError("INVALID_DATA", "invalid content digest");
    const type = mediaType(item.mediaType), name = contentName(item.name);
    if (name !== item.name || type !== item.mediaType) throw new SessionError("INVALID_DATA", "content reference is not canonical");
    return { id: contentId(item.id), name, mediaType: type, kind, bytes: item.bytes, sha256: item.sha256 };
  } catch (error) { throw error instanceof SessionError && error.code === "INVALID_DATA" ? error : new SessionError("INVALID_DATA", "invalid content reference"); }
}
/** Validated public attachment list: unique identities within the per-input count and byte budgets. */
export function parseAttachmentRefs(value: unknown): readonly ContentRef[] {
  if (!Array.isArray(value) || value.length > MAX_RUN_ATTACHMENTS) throw new SessionError("INVALID_DATA", "attachments exceed their budget");
  const refs = value.map(parseContentRef);
  if (new Set(refs.map(ref => ref.id)).size !== refs.length || refs.reduce((total, ref) => total + ref.bytes, 0) > MAX_RUN_ATTACHMENT_BYTES) throw new SessionError("INVALID_DATA", "attachments exceed their budget");
  return refs;
}
/** A stable private copy handed to a Driver. The copy is read-only and kept while any Session references the content. */
export interface ControlAttachment extends ContentRef {
  readonly path: string;
}
/**
 * Owner of stored bytes for user attachments, native outputs and tool details; Session snapshots keep only references.
 * `resolve` is synchronous admission: it confirms the owner still holds each staged upload for the workspace.
 */
/** The bytes of a stored output: all at once, or in pieces as they are made (a tool call's detail of tens of MiB is never held twice). */
export type ContentBytes = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
export interface ContentPort {
  /** Keeps what a Harness made, whole and of any size (at least one byte); a failure to keep it throws, and the caller says on the item that it was not kept. */
  storeOutput(input: { readonly workspace: string; readonly name: string; readonly mediaType: string; readonly data: ContentBytes }): Promise<ContentRef>;
  resolve(ids: readonly string[], workspace: string): readonly ContentRef[];
  materialize(refs: readonly ContentRef[]): Promise<readonly ControlAttachment[]>;
  /**
   * A stored item's bytes as UTF-8 text when it holds at most `maxBytes` and still is exactly `ref` (size and digest);
   * null when it is larger, gone, changed or unreadable, which callers treat as not read (ADR-055 §6.4: the relay then
   * lists the tool by its title and says so). Read-only; absent when the owner cannot read back.
   */
  readText?(ref: ContentRef, maxBytes: number): Promise<string | null>;
  /**
   * A stored item's bytes in pieces, in order, of any size: null when the record and the file are not exactly `ref` in size, or the file cannot be read. The digest is checked as the last piece
   * is read, and a file that is not `ref` ends the iteration with an error instead of its end, so that what was read is never taken for the item. For readers that keep only part of a large
   * item (a tool's detail: the command of a call whose output is megabytes long). Read-only; absent when the owner cannot read back.
   */
  readChunks?(ref: ContentRef): Promise<AsyncIterable<Uint8Array> | null>;
}
