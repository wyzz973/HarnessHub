// SPDX-License-Identifier: MIT
import { localeNames, locales, setLocale, t } from "@/lib/i18n";
import { useLocale } from "@/lib/i18n-react";

/** The console's language, each named in itself; the choice stays in this browser. */
export function LanguageSwitch() {
  const current = useLocale();
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={t("common.language")}
    >
      {locales.map((item) => (
        <button
          key={item}
          type="button"
          role="radio"
          aria-checked={item === current}
          aria-pressed={item === current}
          lang={item}
          onClick={() => setLocale(item)}
        >
          {localeNames[item]}
        </button>
      ))}
    </div>
  );
}
