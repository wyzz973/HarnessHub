import { MARK, type RelayLanguage } from "./escape.js";

/**
 * Egress redaction for what a packet quotes (ADR-055 §10.1–10.2, the MVP of G070): the known secrets of the Session's
 * Harnesses replaced exactly in three spellings, then shape rules, and for command output also credential-named
 * assignments. A hit becomes a protected mark (`MARK` + key + `MARK`) that the escapes leave alone and `restoreLabels` turns
 * into a Hub label such as 〔已脱敏 · GitHub 令牌〕, so no quoted text can forge one. Callers redact a text before they cut
 * it (§5.2 N19), so a cut never leaves part of a secret. Pure: the secret values are given, never looked up.
 */

export type SecretKind = "known" | "private_key" | "anthropic" | "api_key" | "github" | "gitlab" | "npm" | "huggingface" | "aws" | "aws_secret" | "slack" | "google" | "stripe"
  | "webhook" | "jwt" | "bearer" | "basic" | "url_credentials" | "url_query" | "password" | "assignment";
const KEYS: Readonly<Record<SecretKind, string>> = { known: "K", private_key: "P", anthropic: "A", api_key: "O", github: "G", gitlab: "L", npm: "N", huggingface: "H", aws: "W", aws_secret: "X",
  slack: "S", google: "Y", stripe: "T", webhook: "E", jwt: "J", bearer: "B", basic: "C", url_credentials: "U", url_query: "Q", password: "D", assignment: "V" };
const NAMES: Readonly<Record<SecretKind, Readonly<Record<RelayLanguage, string>>>> = {
  known: { zh: "已知凭据", en: "known credential" }, private_key: { zh: "私钥", en: "private key" }, anthropic: { zh: "Anthropic 密钥", en: "Anthropic key" },
  api_key: { zh: "API 密钥", en: "API key" }, github: { zh: "GitHub 令牌", en: "GitHub token" }, gitlab: { zh: "GitLab 令牌", en: "GitLab token" }, npm: { zh: "npm 令牌", en: "npm token" },
  huggingface: { zh: "Hugging Face 令牌", en: "Hugging Face token" }, aws: { zh: "AWS 访问密钥", en: "AWS access key" }, aws_secret: { zh: "AWS 密钥", en: "AWS secret key" },
  slack: { zh: "Slack 令牌", en: "Slack token" }, google: { zh: "Google API 密钥", en: "Google API key" }, stripe: { zh: "Stripe 密钥", en: "Stripe key" },
  webhook: { zh: "Webhook 密钥", en: "webhook secret" }, jwt: { zh: "JWT", en: "JWT" }, bearer: { zh: "Bearer 令牌", en: "bearer token" }, basic: { zh: "Basic 认证", en: "basic auth credentials" },
  url_credentials: { zh: "URL 里的凭据", en: "credentials in a URL" }, url_query: { zh: "URL 参数里的令牌", en: "token in a URL" }, password: { zh: "密码", en: "password" },
  assignment: { zh: "凭据值", en: "credential value" },
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
/** How many protected marks a text holds: the hits that reach the packet. */
export function marksIn(text: string): number { return text.includes(MARK) ? (text.match(/\u0001[A-Z]\u0001/gu) ?? []).length : 0; }
function mark(kind: SecretKind): string { return MARK + KEYS[kind] + MARK; }

const PEM = "(?:[A-Z0-9]+ )*PRIVATE KEY";
/**
 * Shape rules (egress profile), each as [pattern, kind, kept group, probe]: the kept group (1) is what precedes the secret
 * and stays; the probe is a cheap test that text without it cannot match. Private keys come first: a whole block; a block
 * cut before its END line when key material follows its BEGIN line (to the end of the text); the base64 lines right before
 * an END line whose BEGIN was cut off. A BEGIN line in a sentence, without key material after it, is left alone.
 */
const SHAPES: readonly (readonly [RegExp, SecretKind, 0 | 1, RegExp])[] = [
  [new RegExp("-----BEGIN " + PEM + "-----[\\s\\S]*?-----END " + PEM + "-----", "gu"), "private_key", 0, /-----BEGIN /u],
  [new RegExp("-----BEGIN " + PEM + "-----[ \\t]*\\r?\\n(?=[ \\t]*(?:[A-Za-z0-9+/=]{16,}|[A-Za-z-]+:[ \\t]))[\\s\\S]*$", "gu"), "private_key", 0, /-----BEGIN /u],
  [new RegExp("(?<![^\\n])(?:[ \\t]*[A-Za-z0-9+/=]{4,}[ \\t]*\\r?\\n)*[ \\t]*-----END " + PEM + "-----", "gu"), "private_key", 0, /-----END /u],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/gu, "anthropic", 0, /sk-ant-/u],
  // A key has a digit or a capital in it; `sk-learn-preprocessing-pipeline` is a module name.
  [/\bsk-(?:proj-|svcacct-|admin-)?(?=[a-z_-]*[0-9A-Z])[A-Za-z0-9_-]{20,}/gu, "api_key", 0, /sk-/u],
  // Zhipu (GLM) keys: 32 hex digits, a dot, 16 letters and digits with a capital among them (a host label has none).
  [/\b[0-9a-f]{32}\.(?=[a-z0-9]*[A-Z])[A-Za-z0-9]{16}(?![A-Za-z0-9])/gu, "api_key", 0, /[0-9a-f]{32}\./u],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/gu, "github", 0, /gh[pousr]_|github_pat_/u],
  [/\bglpat-[A-Za-z0-9_-]{20,}/gu, "gitlab", 0, /glpat-/u],
  [/\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/gu, "npm", 0, /npm_/u],
  [/\bhf_[A-Za-z0-9]{30,}(?![A-Za-z0-9_])/gu, "huggingface", 0, /hf_/u],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/gu, "aws", 0, /A[KS]IA/u],
  [/(\b(?:aws_secret_access_key|secret_access_key|SecretAccessKey|aws_session_token)["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40,}/giu, "aws_secret", 1, /secret_?access|session_?token/iu],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/gu, "slack", 0, /xox/u],
  [/(https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9/_-]{10,}/gu, "webhook", 1, /hooks\.slack\.com/u],
  [/\bwhsec_[A-Za-z0-9+/=]{20,}/gu, "webhook", 0, /whsec_/u],
  [/\bAIza[0-9A-Za-z_-]{35}/gu, "google", 0, /AIza/u],
  [/\b[rs]k_live_[0-9A-Za-z]{20,}/gu, "stripe", 0, /k_live_/u],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, "jwt", 0, /eyJ/u],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/giu, "bearer", 1, /bearer/iu],
  // Basic credentials: after an Authorization header, or a base64 token of ≥16 characters with a digit, + / or = in it.
  [/(\bAuthorization:\s*Basic\s+)[A-Za-z0-9+/]{8,}={0,2}/giu, "basic", 1, /basic/iu],
  [/(\bBasic\s+)(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{16,}={0,2}(?![A-Za-z0-9+/=])/gu, "basic", 1, /Basic /u],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/giu, "url_credentials", 1, /:\/\/[^\s@]*@/u],
  // A token in a URL's query: only these parameter names, and a value of ≥12 characters (examples are shorter).
  [/((?:[?&;]|&amp;)(?:access_token|private_token|refresh_token|id_token|auth_token|token|api_key|apikey|api-key|key|secret|client_secret|password|passwd|pwd|auth|sig|signature)=)[^&#\s'"<>]{12,}/giu, "url_query", 1, /[?&;][A-Za-z_-]+=/u],
  // Passwords on command lines: `-u user:pass` (curl, wget), `--password X`, `mysql -pX`, `docker login -p X`, `sshpass -p X`, PGPASSWORD=X.
  // `-u https://host` is a URL; a numeric uid:gid and a container's `-u user:group` are no user and password (N2).
  [/(?<!\b(?:docker|podman|nerdctl)\b[^\n]*)((?:^|\s)(?:-u|--user)(?:\s+|=)['"]?(?!\d+:\d+(?![^\s'"]))[^\s:'"@]+:)(?!\/\/)[^\s'"@]+/gmu, "password", 1, /-u|--user/u],
  [/(--password(?:=|\s+)['"]?)[^\s'"]+/gu, "password", 1, /--password/u],
  [/(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n]*?\s-p)[^\s'"-][^\s'"]*/gu, "password", 1, /mysql|mariadb/u],
  [/(\b(?:docker|podman|nerdctl|helm)\s+(?:registry\s+)?login\b[^\n]*?\s-p\s+['"]?)[^\s'"]+/gu, "password", 1, /login/u],
  [/(\bsshpass\s+-p\s*['"]?)[^\s'"]+/gu, "password", 1, /sshpass/u],
  [/(\b(?:PGPASSWORD|MYSQL_PWD|REDISCLI_AUTH)=['"]?)[^\s'"]+/gu, "password", 1, /PGPASSWORD|MYSQL_PWD|REDISCLI_AUTH/u],
];
/** The parts of a variable's or a key's name: split at `_`, `.`, `-` and at case changes (`apiKey`, `APIKey`, `x-api-key`). */
function nameParts(name: string): readonly string[] {
  return name.split(/[_.-]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/u).filter(part => part !== "");
}
/** Words that name a credential when they are a part of a name. */
const CREDENTIAL_WORDS = new Set(["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PWD", "CREDENTIAL", "CREDENTIALS", "AUTH", "COOKIE", "SESSION", "PRIVATE", "SIGNING", "WEBHOOK", "DSN", "API"]);
/** Of them, those that as a whole name are ordinary words of logs and configuration (`key: …`, `session: …`, `"private": true`). */
const ORDINARY_ALONE = new Set(["KEY", "AUTH", "COOKIE", "SESSION", "PRIVATE", "SIGNING", "DSN", "API"]);
/**
 * Whether a name reads as a credential's: one of CREDENTIAL_WORDS as one of its parts, or an upper-case part that ends in
 * KEY, TOKEN, SECRET, PASSWORD or PASSWD (`CORP_APIKEY`); never one of ORDINARY_ALONE as the whole name, nor a lower-case
 * word that only ends in one (`jsonwebtoken`, `user.signingkey`) (N2).
 */
function credentialName(name: string): boolean {
  const parts = nameParts(name);
  if (parts.length === 1 && ORDINARY_ALONE.has(parts[0]!.toUpperCase())) return false;
  return parts.some(part => CREDENTIAL_WORDS.has(part.toUpperCase()) || (part === part.toUpperCase() && /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)$/u.test(part)));
}
/** The last parts of names that only locate or configure something (m5: a mirror's domain, a host, a model). */
const LOCATING_WORDS = new Set(["MODEL", "REGION", "PROFILE", "DIR", "PATH", "HOME", "URL", "URI", "HOST", "HOSTNAME", "DOMAIN", "PORT", "ENDPOINT", "BASE", "SERVER", "ADDR", "ADDRESS",
  "VERSION", "TIMEOUT", "MODE", "USER", "USERNAME", "NAME", "TYPE", "FILE", "ID", "PREFIX", "SUFFIX"]);
/**
 * Whether a name only locates or configures, whatever credential word it holds (`HOMEBREW_API_DOMAIN`, `tokenEndpoint`);
 * never a webhook's, whose address is its secret (`FEISHU_WEBHOOK_URL`, N1).
 */
function locating(name: string): boolean {
  const parts = nameParts(name);
  return parts.length > 1 && LOCATING_WORDS.has(parts.at(-1)!.toUpperCase()) && !parts.some(part => part.toUpperCase().includes("WEBHOOK"));
}
/**
 * Command output only: a credential-named assignment that makes a whole line (`NAME=value`, `export NAME=value`, `name:
 * value` with a space after the colon, `"name": "value",`) has its value hidden when it can be a secret (`plausible`); the
 * name stays. A value followed by more words is a sentence (`token: expired at …`) and `api:build:` a task's prefix (N2).
 * Command text is never rewritten by this rule.
 */
const ASSIGNMENT = /^([ \t]*(?:export[ \t]+)?["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?(?:[ \t]*=[ \t]*|[ \t]*:[ \t]+)["']?)([^\s"'#,;]{4,})(?=["']?[ \t]*(?:[,;#]|$))/gmu;

/** A redactor for one rendering. */
export interface RelayRedactor {
  /**
   * The text with every hit replaced by its protected mark, and how many hits there were; `output` (command output) also
   * hides the values of credential-named assignments.
   */
  redact(text: string, kind?: "text" | "output"): { readonly text: string; readonly hits: number };
}
/** Values shorter than this, and plain numbers and booleans, are too common to treat as secrets. */
export const MIN_SECRET_LENGTH = 6;
/**
 * Whether a value can be a secret worth hiding: long enough, and not a number, a boolean, a short lower-case word (`postgres`,
 * `redis`: at most 8 letters, N1), a host or an address (`localhost`, `10.0.0.1`), a version (`^9.0.2`), a plain absolute
 * path (`/api/v1`), a mask (`********`) or a placeholder (`(hidden)`, `<none>`) (N2). Hiding such a value would cut ordinary
 * words out of the record (m5). A URL can be a secret, a webhook's token being in its path (N1); mirrors and endpoints are
 * left out by their names instead (`locating`).
 */
function plausible(value: string): boolean {
  const text = value.trim();
  if (text.length < MIN_SECRET_LENGTH || /^(?:\d+|true|false|yes|no|on|off|null|none)$/iu.test(text) || /^[a-z]{1,8}$/u.test(text)) return false;
  // A host or an address: lower-case labels ending in a letters-only one, a dotted number, an IPv6 address (with colons).
  if (/^(?:localhost|[0-9.]+|[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}|[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*\.[a-z]{2,24})$/u.test(text)) return false;
  return !(/^[\^~<>=v]{0,3}\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/u.test(text) || /^(?:\/[a-z0-9._-]+)+\/?$/u.test(text) || !/[A-Za-z0-9]/u.test(text) || /^[([{<].*[)\]}>]$/u.test(text));
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
    redact(text: string, kind: "text" | "output" = "text") {
      if (text === "") return { text, hits: 0 };
      let hits = 0, value = text;
      const [whole, cut, orphan, ...rest] = SHAPES;
      for (const [pattern, , , probe] of [whole!, cut!, orphan!]) if (probe.test(value)) value = value.replace(pattern, () => { hits++; return mark("private_key"); });
      if (known !== null) value = value.replace(known, () => { hits++; return mark("known"); });
      for (const [pattern, shape, kept, probe] of rest) if (probe.test(value)) value = value.replace(pattern, (...match: unknown[]) => { hits++; return (kept ? String(match[1]) : "") + mark(shape); });
      if (kind === "output" && /[=:]/u.test(value)) value = value.replace(ASSIGNMENT, (whole: string, before: string, name: string, secret: string) => {
        if (!credentialName(name) || locating(name) || secret.includes(MARK) || !plausible(secret)) return whole;
        hits++; return before + mark("assignment");
      });
      return { text: value, hits };
    },
  };
}

/**
 * The values to treat as known secrets (ADR-055 §10.2 (a)–(c)): every value an environment holds under a credential name
 * (see `credentialName`), and every value a Harness's configuration references by name, whatever the name; in both, a name
 * that only locates or configures (see `locating`) is left out, and so is a value that is no plausible secret (see
 * `plausible`) or an existing path (`existingPath`, the caller's own check). Sorted, without duplicates.
 */
export function credentialValues(input: { readonly environments: readonly Readonly<Record<string, string>>[]; readonly referenced: readonly (readonly [string, string])[] }, existingPath: (value: string) => boolean = () => false): readonly string[] {
  const values = new Set<string>();
  const keep = (value: unknown) => { if (typeof value === "string" && plausible(value) && !(value.startsWith("/") && existingPath(value))) values.add(value); };
  for (const environment of input.environments) for (const [name, value] of Object.entries(environment)) if (credentialName(name) && !locating(name)) keep(value);
  for (const [name, value] of input.referenced) if (!locating(name)) keep(value);
  return [...values].sort();
}

/** File names whose content is a credential (ADR-055 §10.1); examples meant to be committed (.env.example, .env.local.example) are not. */
const CREDENTIAL_FILE = /^(?:\.env(?!(?:\.[^.]+)*\.(?:example|sample|template|dist)$)(?:\..+)?|\.envrc|.+\.(?:pem|key|p12|pfx|jks|keystore|kdbx|tfvars)|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|id_\*|\.?credentials(?:\.json)?|auth\.json|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.pgpass|\.my\.cnf|kubeconfig|terraform\.tfstate(?:\.backup)?)$/iu;
/**
 * Whether a command names a credential file (ADR-055 §10.1: `.env*`, `*.pem`, `id_*` keys, `*credentials*`, `auth.json`,
 * `.npmrc`, `.netrc`, `.git-credentials`, `kubeconfig`, `*.tfvars`, `terraform.tfstate`, anything under `.ssh/`, `.aws/`,
 * `.docker/config.json`, `.kube/config`): its output is then never quoted, only counted.
 */
export function namesCredentialFile(command: string): boolean {
  for (const raw of command.split(/[\s|;&<>()`$=,]+/u)) {
    const token = raw.replace(/^['"]+|['"]+$/gu, "");
    if (token === "") continue;
    if (/(?:^|\/)\.(?:ssh|aws|gnupg)\/|(?:^|\/)\.docker\/config\.json$|(?:^|\/)\.kube\/config$/u.test(token)) return true;
    if (CREDENTIAL_FILE.test(token.slice(token.lastIndexOf("/") + 1))) return true;
  }
  return false;
}
