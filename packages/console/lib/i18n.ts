// SPDX-License-Identifier: MIT
/**
 * The console's languages: messages, the chosen locale and locale-aware
 * formatting. zh-CN is the source catalog and en its translation
 * (lib/messages). The locale is chosen in the settings and kept in this
 * browser; until then it follows the browser's languages. Problem details
 * from the daemon are shown as the daemon sends them.
 */
import { en, zhCN } from "./messages";
import type { Placeholders } from "./messages/types";

export const locales = ["zh-CN", "en"] as const;
export type Locale = (typeof locales)[number];

export const localeNames: Readonly<Record<Locale, string>> = {
  "zh-CN": "中文",
  en: "English",
};

type Catalog = typeof zhCN;
export type MessageKey = keyof Catalog;
/** The values a message needs, by placeholder name; none for a plain message. */
export type MessageParams<Key extends MessageKey> = Record<
  Placeholders<Catalog[Key]>,
  string | number
>;

const catalogs: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> =
  { "zh-CN": zhCN, en };

const STORAGE_KEY = "harnesshub.locale";

function isLocale(value: unknown): value is Locale {
  return (locales as readonly unknown[]).includes(value);
}

/** The locale of a browser's preferred languages: the first Chinese or English one, else English. */
export function preferredLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const tag = language.toLowerCase();
    if (tag === "zh" || tag.startsWith("zh-")) return "zh-CN";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return "en";
}

function stored(): Locale | undefined {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isLocale(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function initial(): Locale {
  const fromStorage = stored();
  if (fromStorage) return fromStorage;
  const navigatorValue = globalThis.navigator;
  if (!navigatorValue) return "zh-CN";
  return preferredLocale(
    navigatorValue.languages?.length
      ? navigatorValue.languages
      : [navigatorValue.language],
  );
}

let current: Locale = initial();
const listeners = new Set<() => void>();

/** The locale in use. */
export function locale(): Locale {
  return current;
}

/**
 * Switch the console's language and remember it in this browser (a
 * browser that keeps no storage switches for this page only).
 */
export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next);
  } catch {
    // Storage may be unavailable; the choice then lasts for this page.
  }
  if (globalThis.document) globalThis.document.documentElement.lang = next;
  for (const listener of listeners) listener();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * A message's text with its values in place, as parts: strings, and the
 * values that are not text (React nodes for lib/i18n-react.tsx) where
 * they go. Numbers are formatted for the locale; `{n, plural, one {…}
 * other {…}}` picks the locale's plural form, with `#` for the number.
 */
export function messageParts(
  template: string,
  params: Readonly<Record<string, unknown>> = {},
  forLocale: Locale = current,
): unknown[] {
  const parts: unknown[] = [];
  let text = "";
  let at = 0;
  while (at < template.length) {
    const open = template.indexOf("{", at);
    if (open < 0) {
      text += template.slice(at);
      break;
    }
    text += template.slice(at, open);
    // The placeholder ends at its matching brace (plural forms nest one level).
    let depth = 0;
    let close = open;
    for (; close < template.length; close++) {
      if (template[close] === "{") depth++;
      else if (template[close] === "}" && --depth === 0) break;
    }
    const body = template.slice(open + 1, close);
    at = close + 1;
    const comma = body.indexOf(",");
    const name = (comma < 0 ? body : body.slice(0, comma)).trim();
    const value = params[name];
    if (
      comma >= 0 &&
      body
        .slice(comma + 1)
        .trim()
        .startsWith("plural")
    ) {
      const count = Number(value);
      const forms = new Map<string, string>();
      for (const match of body.matchAll(
        /(=\d+|zero|one|two|few|many|other)\s*\{([^}]*)\}/g,
      ))
        forms.set(match[1]!, match[2]!);
      const form =
        forms.get(`=${count}`) ??
        forms.get(new Intl.PluralRules(forLocale).select(count)) ??
        forms.get("other") ??
        "";
      text += form.replaceAll("#", formatNumber(count, forLocale));
      continue;
    }
    if (typeof value === "number") text += formatNumber(value, forLocale);
    else if (typeof value === "string") text += value;
    else if (value === undefined || value === null) text += `{${name}}`;
    else {
      if (text) parts.push(text);
      text = "";
      parts.push(value);
    }
  }
  if (text) parts.push(text);
  return parts;
}

/** The text of a message in the current locale. */
export function t<Key extends MessageKey>(
  key: Key,
  ...[params]: [Placeholders<Catalog[Key]>] extends [never]
    ? []
    : [MessageParams<Key>]
): string {
  return messageParts(catalogs[current][key], params).join("");
}

/** Whether `key` names a message, for keys built from values the daemon sends. */
export function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(zhCN, key);
}

/**
 * The text of a message chosen at run time (a code or a kind the daemon
 * sends), whose placeholders the caller cannot know statically.
 */
export function translate(
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
): string {
  return messageParts(catalogs[current][key], params).join("");
}

/** A message's template in a locale, for lib/i18n-react.tsx and the tests. */
export function template(key: MessageKey, forLocale: Locale = current): string {
  return catalogs[forLocale][key];
}

export function formatNumber(
  value: number,
  forLocale: Locale = current,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(forLocale, options).format(value);
}

/** A date and time in the locale, from an ISO string, a timestamp or a Date. */
export function formatDateTime(
  value: string | number | Date,
  forLocale: Locale = current,
): string {
  return new Date(value).toLocaleString(forLocale);
}

export function formatDate(
  value: string | number | Date,
  forLocale: Locale = current,
): string {
  return new Date(value).toLocaleDateString(forLocale);
}

export function formatTime(
  value: string | number | Date,
  forLocale: Locale = current,
): string {
  return new Date(value).toLocaleTimeString(forLocale);
}

/**
 * A US dollar amount (the API's decimal strings or numbers) in the
 * locale's currency format, keeping up to 10 decimals so small costs
 * still show.
 */
export function formatUsd(
  amount: string | number,
  forLocale: Locale = current,
): string {
  return new Intl.NumberFormat(forLocale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 10,
  }).format(Number(amount));
}
