/*
 * FROZEN COPY (ADR-057 3.6, step-2 plan T2): taken from src/contracts/content.ts (the stored reference's parsers and their budgets) as it was at the end of store v13 (commit 1a5f020), WITHOUT its bounds lifted.
 * The conversion of a v13 database (and the ladder from v1 to v13 that runs before it) reads old snapshots with exactly this code, so that nothing the
 * live code changes later (a bound opened, a field added) can change what an old snapshot means. Do not edit it and do not import a live parser into it;
 * tests/integration/legacy-parse.test.ts holds it to the live code on the repository's fixtures and holds this folder to its own imports.
 */

import type { ContentId, ContentRef } from "../../../contracts/content.js";
import { SessionError } from "../../../contracts/session.js";

/** Per item budget for stored bytes; native transport limits are checked again by each Driver. */
export const MAX_CONTENT_BYTES = 20 * 1024 * 1024;
/** User attachments admitted with one input. */
export const MAX_RUN_ATTACHMENTS = 8;
export const MAX_RUN_ATTACHMENT_BYTES = 32 * 1024 * 1024;
export const MAX_RUN_OUTPUTS = 32;
export const MAX_CONTENT_NAME_BYTES = 255;

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
    if (typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > MAX_CONTENT_BYTES) throw new SessionError("INVALID_DATA", "invalid content size");
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
