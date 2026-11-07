import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge told about the design tokens of styles.css (ADR-054): without this it would read `text-ui` as a text
 * color and drop it next to `text-fg-2`, and could not tell that `rounded-card` and `rounded-row` replace each other.
 */
const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["greeting", "title", "section", "panel", "reading", "ui", "ui-sm", "caption", "code"],
      radius: ["tag", "row", "control", "block", "card", "composer"],
      shadow: ["hairline", "card", "card-hover", "composer", "focus", "pop", "well"],
      ease: ["snap", "expo", "overshoot", "standard", "panel", "token"],
    },
  },
});

/** Joins class names; a later Tailwind utility replaces an earlier one of the same property. */
export function cn(...values: readonly ClassValue[]): string { return merge(clsx(values)); }
