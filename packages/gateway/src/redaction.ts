// SPDX-License-Identifier: MIT
/**
 * Outbound secret redaction (Magpie `internal/redact`, narrowed to known
 * secrets): before a request goes upstream, every known secret value in its
 * text is replaced by a stable placeholder, so a vendor never sees HarnessHub's
 * own credentials even when a prompt or a tool result quotes them. Known
 * secrets are Gateway Keys (by their issued shape), the provider credentials
 * and subscription tokens this process resolved, values the owner passes in
 * (the admin token), and the user's own patterns.
 *
 * A placeholder is `{{HH_<KIND>_<8 base32 characters>}}`, a keyed hash of the
 * value under a key that lives only in this process: the same value gets the
 * same placeholder in every request, so a conversation's history reads the
 * same turn after turn, and a placeholder says nothing about its value. The
 * values are held in memory by placeholder, for {@link Redactor.restore}.
 */
import { createHmac, randomBytes } from "node:crypto";
import {
  redactionRuleProblem,
  type RedactionRule,
  type RedactionSettings,
} from "@harnesshub/core/gateway-features";

export type { RedactionRule, RedactionSettings };

/** Kinds of the values HarnessHub knows; a user rule's kind is its name. */
export type SecretKind = "GATEWAY_KEY" | "PROVIDER_KEY" | "ADMIN_TOKEN";

/** Exact values shorter than this are not treated as secrets. */
const MIN_SECRET = 8;
/** Placeholders kept for restoring; past this the oldest half is dropped. */
const MAX_PLACEHOLDERS = 50_000;
/** Exact values remembered; past this the oldest half is dropped. */
const MAX_KNOWN = 10_000;
/** A Gateway Key as `issueGatewayKey` writes it. */
const GATEWAY_KEY =
  /hhk_[asc]_[a-z2-7]{12}_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
const PLACEHOLDER = /\{\{HH_[A-Z0-9_]+_[a-z2-7]{8}\}\}/g;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Keys whose string values are left alone: identifiers, names and kinds the
 * vendor needs as they are, and sealed or encoded data (Magpie's `kept`).
 */
const KEPT = new Set([
  "model",
  "id",
  "call_id",
  "tool_call_id",
  "tool_use_id",
  "item_id",
  "previous_response_id",
  "prompt_cache_key",
  "type",
  "role",
  "name",
  "signature",
  "thoughtSignature",
  "thought_signature",
  "encrypted_content",
  "data",
  "media_type",
  "mime_type",
  "mimeType",
  "file_id",
  "reasoning_effort",
  "effort",
  "status",
  "object",
]);

/** Checks a user rule; the reason it is invalid, or undefined. */
export const ruleProblem = (rule: RedactionRule): string | undefined =>
  redactionRuleProblem(rule);

interface Span {
  start: number;
  end: number;
  kind: string;
}

/**
 * The redaction state of one gateway handler: the key, the known values and
 * the placeholders made so far.
 */
export class Redactor {
  #key = randomBytes(32);
  #known = new Map<string, SecretKind>();
  #values = new Map<string, string>();
  #compiled = new Map<string, RegExp>();

  /** Treat `value` as a secret from now on; short values are ignored. */
  remember(value: string, kind: SecretKind): void {
    if (value.length < MIN_SECRET || this.#known.has(value)) return;
    if (this.#known.size >= MAX_KNOWN) this.#trim(this.#known, MAX_KNOWN);
    this.#known.set(value, kind);
  }

  #trim<K, V>(map: Map<K, V>, max: number): void {
    let drop = Math.floor(max / 2);
    for (const key of map.keys()) {
      if (drop-- <= 0) break;
      map.delete(key);
    }
  }

  #placeholder(kind: string, value: string): string {
    const digest = createHmac("sha256", this.#key)
      .update(`${kind}\u0000${value}`)
      .digest();
    let suffix = "";
    for (let index = 0; index < 8; index++)
      suffix += BASE32[digest[index]! & 31];
    const placeholder = `{{HH_${kind}_${suffix}}}`;
    if (!this.#values.has(placeholder)) {
      if (this.#values.size >= MAX_PLACEHOLDERS)
        this.#trim(this.#values, MAX_PLACEHOLDERS);
      this.#values.set(placeholder, value);
    }
    return placeholder;
  }

  #rule(rule: RedactionRule): RegExp | undefined {
    const key = `${rule.flags ?? ""}/${rule.pattern}`;
    let compiled = this.#compiled.get(key);
    if (!compiled) {
      if (ruleProblem(rule)) return undefined;
      compiled = new RegExp(rule.pattern, `g${rule.flags ?? ""}`);
      if (this.#compiled.size > 256) this.#compiled.clear();
      this.#compiled.set(key, compiled);
    }
    return compiled;
  }

  /** `text` with every secret replaced; `count` is how many were. */
  mask(
    text: string,
    rules: readonly RedactionRule[] = [],
  ): { text: string; count: number } {
    if (text.length < MIN_SECRET) return { text, count: 0 };
    const found: Span[] = [];
    for (const [value, kind] of this.#known)
      for (
        let index = text.indexOf(value);
        index >= 0;
        index = text.indexOf(value, index + value.length)
      )
        found.push({ start: index, end: index + value.length, kind });
    if (text.includes("hhk_"))
      for (const match of text.matchAll(GATEWAY_KEY))
        found.push({
          start: match.index,
          end: match.index + match[0].length,
          kind: "GATEWAY_KEY",
        });
    for (const rule of rules) {
      const pattern = this.#rule(rule);
      if (!pattern) continue;
      for (const match of text.matchAll(pattern)) {
        const value = match[1] ?? match[0];
        if (!value) continue;
        const start =
          match[1] === undefined
            ? match.index
            : match.index + match[0].indexOf(match[1]);
        found.push({
          start,
          end: start + value.length,
          kind: rule.name.toUpperCase(),
        });
      }
    }
    if (!found.length) return { text, count: 0 };
    // Nothing inside a placeholder already there; earlier and longer first.
    const placeholders = text.includes("{{HH_")
      ? [...text.matchAll(PLACEHOLDER)].map((match) => [
          match.index,
          match.index + match[0].length,
        ])
      : [];
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    let out = "";
    let at = 0;
    let count = 0;
    for (const span of found) {
      if (span.start < at) continue;
      if (placeholders.some(([s, e]) => span.start < e! && span.end > s!))
        continue;
      out += text.slice(at, span.start);
      out += this.#placeholder(span.kind, text.slice(span.start, span.end));
      at = span.end;
      count++;
    }
    return count ? { text: out + text.slice(at), count } : { text, count: 0 };
  }

  /**
   * A JSON value with every string masked, except under {@link KEPT} keys
   * and `data:` URLs. The value is copied only where something changed.
   */
  maskJson(
    value: unknown,
    rules: readonly RedactionRule[] = [],
  ): { value: unknown; count: number } {
    let count = 0;
    const walk = (item: unknown, key: string | undefined): unknown => {
      if (typeof item === "string") {
        if ((key !== undefined && KEPT.has(key)) || item.startsWith("data:"))
          return item;
        const masked = this.mask(item, rules);
        count += masked.count;
        return masked.text;
      }
      if (Array.isArray(item)) {
        let changed = false;
        const copy = item.map((element) => {
          const next = walk(element, undefined);
          if (next !== element) changed = true;
          return next;
        });
        return changed ? copy : item;
      }
      if (typeof item === "object" && item !== null) {
        let changed = false;
        const copy: Record<string, unknown> = {};
        for (const [name, element] of Object.entries(item)) {
          const next = walk(element, name);
          if (next !== element) changed = true;
          copy[name] = next;
        }
        return changed ? copy : item;
      }
      return item;
    };
    const masked = walk(value, undefined);
    return { value: masked, count };
  }

  /**
   * `text` with the placeholders this redactor made replaced by their
   * values; `escape` writes each value as it must appear inside a JSON
   * string (for JSON argument text).
   */
  restore(text: string, escape: boolean): { text: string; count: number } {
    if (!text.includes("{{HH_")) return { text, count: 0 };
    let count = 0;
    const restored = text.replace(PLACEHOLDER, (placeholder) => {
      const value = this.#values.get(placeholder);
      if (value === undefined) return placeholder;
      count++;
      return escape ? JSON.stringify(value).slice(1, -1) : value;
    });
    return { text: restored, count };
  }

  /** A JSON value with placeholders in its strings restored (tool arguments as objects). */
  restoreJson(value: unknown): { value: unknown; count: number } {
    let count = 0;
    const walk = (item: unknown): unknown => {
      if (typeof item === "string") {
        const restored = this.restore(item, false);
        count += restored.count;
        return restored.text;
      }
      if (Array.isArray(item)) return item.map(walk);
      if (typeof item === "object" && item !== null)
        return Object.fromEntries(
          Object.entries(item).map(([name, element]) => [name, walk(element)]),
        );
      return item;
    };
    const restored = walk(value);
    return { value: count ? restored : value, count };
  }
}

/**
 * A JSON request body with its secrets masked, when redaction is on; the
 * body is re-serialized only when something was masked. A body that is not
 * JSON is returned as it is.
 */
export function maskBody(
  redactor: Redactor,
  settings: RedactionSettings,
  body: Buffer,
): { body: Buffer; count: number } {
  if (!settings.enabled) return { body, count: 0 };
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return { body, count: 0 };
  }
  const masked = redactor.maskJson(value, settings.rules);
  return masked.count
    ? { body: Buffer.from(JSON.stringify(masked.value)), count: masked.count }
    : { body, count: 0 };
}
