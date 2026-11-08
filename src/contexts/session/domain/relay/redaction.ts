import { MARK, type RelayLanguage } from "./escape.js";

/**
 * Egress redaction for what a packet quotes (ADR-055 §10.2, the MVP of G070): the known secrets a binding hands its program
 * replaced exactly in three spellings, then a few shape rules. A hit becomes a protected mark (`MARK` + key + `MARK`) that
 * the escapes leave alone and `restoreLabels` turns into a Hub label such as 〔已脱敏 · GitHub 令牌〕, so no quoted text can
 * forge one. Pure: the secret values are given, never looked up.
 */

export type SecretKind = "known" | "private_key" | "anthropic" | "api_key" | "github" | "aws" | "slack" | "google" | "stripe" | "jwt" | "bearer" | "url_credentials";
const KEYS: Readonly<Record<SecretKind, string>> = { known: "K", private_key: "P", anthropic: "A", api_key: "O", github: "G", aws: "W", slack: "S", google: "Y", stripe: "T", jwt: "J", bearer: "B", url_credentials: "U" };
const NAMES: Readonly<Record<SecretKind, Readonly<Record<RelayLanguage, string>>>> = {
  known: { zh: "已知凭据", en: "known credential" }, private_key: { zh: "私钥", en: "private key" }, anthropic: { zh: "Anthropic 密钥", en: "Anthropic key" },
  api_key: { zh: "API 密钥", en: "API key" }, github: { zh: "GitHub 令牌", en: "GitHub token" }, aws: { zh: "AWS 访问密钥", en: "AWS access key" },
  slack: { zh: "Slack 令牌", en: "Slack token" }, google: { zh: "Google API 密钥", en: "Google API key" }, stripe: { zh: "Stripe 密钥", en: "Stripe key" },
  jwt: { zh: "JWT", en: "JWT" }, bearer: { zh: "Bearer 令牌", en: "bearer token" }, url_credentials: { zh: "URL 里的凭据", en: "credentials in a URL" },
};
const KINDS = new Map(Object.entries(KEYS).map(([kind, key]) => [key, kind as SecretKind]));
/** The label a hit of `kind` is shown as; the brackets are the Hub's own, which no quoted text can carry (escape.ts N4). */
export function labelOf(kind: SecretKind, language: RelayLanguage): string {
  return language === "zh" ? "〔已脱敏 · " + NAMES[kind].zh + "〕" : "〔redacted · " + NAMES[kind].en + "〕";
}
/** Every protected mark in an escaped text becomes its label. */
export function restoreLabels(text: string, language: RelayLanguage): string {
  return text.includes(MARK) ? text.replace(/\u0001([A-Z])\u0001/gu, (_whole, key: string) => labelOf(KINDS.get(key) ?? "known", language)) : text;
}
function mark(kind: SecretKind): string { return MARK + KEYS[kind] + MARK; }

/**
 * Shape rules (egress profile): private key blocks (to their END line, or to the end of the text when it was cut), then
 * Anthropic and other `sk-` keys, GitHub tokens, AWS access key ids, Slack tokens, Google API keys, Stripe live keys, JWTs,
 * the token after `Bearer`, and the password in a URL's user information. Each keeps whatever precedes its secret.
 */
const SHAPES: readonly (readonly [RegExp, SecretKind, number, RegExp])[] = [
  // Each rule's last pattern is a cheap probe: text without it cannot match the rule, so the rule is not run on it.
  [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/gu, "private_key", 0, /-----BEGIN /u],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/gu, "anthropic", 0, /sk-ant-/u],
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/gu, "api_key", 0, /sk-/u],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/gu, "github", 0, /gh[pousr]_|github_pat_/u],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/gu, "aws", 0, /A[KS]IA/u],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/gu, "slack", 0, /xox/u],
  [/\bAIza[0-9A-Za-z_-]{35}/gu, "google", 0, /AIza/u],
  [/\b[rs]k_live_[0-9A-Za-z]{20,}/gu, "stripe", 0, /k_live_/u],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, "jwt", 0, /eyJ/u],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/giu, "bearer", 1, /bearer/iu],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/giu, "url_credentials", 1, /:\/\/[^\s@]*@/u],
];

/** A redactor for one rendering: what it replaces and how many hits it replaced. */
export interface RelayRedactor {
  /** The text with every hit replaced by its protected mark, and how many hits there were. */
  redact(text: string): { readonly text: string; readonly hits: number };
}
/** Values shorter than this, and plain numbers and booleans, are too common to treat as secrets. */
export const MIN_SECRET_LENGTH = 6;
function plausible(value: string): boolean {
  return value.length >= MIN_SECRET_LENGTH && !/^(?:\d+|true|false|yes|no|on|off|null|none)$/iu.test(value.trim());
}
/**
 * A redactor that replaces each known secret as it is, JSON-escaped and URL-encoded (longest spelling first, so a value
 * contained in another never splits it), then the shape rules. Values that are not plausible secrets (see `plausible`) are
 * ignored. Deterministic for a given set of values, whatever their order.
 */
export function relayRedactor(secrets: readonly string[]): RelayRedactor {
  const forms = new Set<string>();
  for (const value of secrets) {
    if (typeof value !== "string" || !plausible(value)) continue;
    for (const form of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]) if (form.length >= MIN_SECRET_LENGTH) forms.add(form);
  }
  const ordered = [...forms].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  const known = ordered.length === 0 ? null : new RegExp(ordered.map(form => form.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")).join("|"), "g");
  return {
    redact(text: string) {
      if (text === "") return { text, hits: 0 };
      let hits = 0, value = text;
      const [pem, ...rest] = SHAPES;
      if (pem![3].test(value)) value = value.replace(pem![0], () => { hits++; return mark("private_key"); });
      if (known !== null) value = value.replace(known, () => { hits++; return mark("known"); });
      for (const [pattern, kind, kept, probe] of rest) if (probe.test(value)) value = value.replace(pattern, (...match: unknown[]) => { hits++; return (kept ? String(match[1]) : "") + mark(kind); });
      return { text: value, hits };
    },
  };
}

/** Variable names that read as credentials: one of these words, delimited by the name's ends or underscores, or ending it. */
const CREDENTIAL_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|COOKIE|SESSION|PRIVATE|SIGNING|WEBHOOK|DSN|API)(?:_|$)|(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)$/iu;
/** Names that only locate or configure something, whatever word they hold. */
const LOCATING_NAME = /_(?:MODEL|REGION|PROFILE|DIR|PATH|HOME|URL)$/iu;
/**
 * The values to treat as known secrets (ADR-055 §10.2 (a)–(c)): every value an environment holds under a credential name
 * (see CREDENTIAL_NAME, except names that only locate or configure: *_MODEL, *_REGION, *_PROFILE, *_DIR, *_PATH, *_HOME,
 * *_URL), and every value a Harness's configuration references by name, whatever the name. A value that is an existing
 * path (`existingPath`, the caller's own check), too short, a number or a boolean is left out. Sorted, without duplicates.
 */
export function credentialValues(input: { readonly environments: readonly Readonly<Record<string, string>>[]; readonly referenced: readonly string[] }, existingPath: (value: string) => boolean = () => false): readonly string[] {
  const values = new Set<string>();
  const keep = (value: unknown) => { if (typeof value === "string" && plausible(value) && !(value.startsWith("/") && existingPath(value))) values.add(value); };
  for (const environment of input.environments) for (const [name, value] of Object.entries(environment)) if (CREDENTIAL_NAME.test(name) && !LOCATING_NAME.test(name)) keep(value);
  for (const value of input.referenced) keep(value);
  return [...values].sort();
}
