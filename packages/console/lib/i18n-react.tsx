// SPDX-License-Identifier: MIT
/**
 * React bindings of lib/i18n.ts: the locale as state, the root that
 * renders the console again in a new language, and messages with React
 * nodes (links, code) in their placeholders.
 */
import { createElement, Fragment, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { Placeholders } from "./messages/types";
import type { zhCN } from "./messages";
import {
  locale,
  messageParts,
  subscribeLocale,
  template,
  type Locale,
  type MessageKey,
} from "./i18n";

/** The locale in use, following `setLocale`. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, locale, locale);
}

/**
 * Renders `children` again from scratch when the language changes, so
 * every text, including those computed once on mount, is in the new one.
 */
export function LocaleRoot({ children }: { children: ReactNode }) {
  const current = useLocale();
  return createElement(Fragment, { key: current }, children);
}

/** A message whose values may be React nodes, such as a link or `<code>`. */
export function tr<Key extends MessageKey>(
  key: Key,
  params: Record<Placeholders<(typeof zhCN)[Key]>, ReactNode>,
): ReactNode {
  return createElement(
    Fragment,
    null,
    ...(messageParts(template(key), params) as ReactNode[]),
  );
}
