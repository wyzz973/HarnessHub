// SPDX-License-Identifier: MIT
/**
 * Types of the console's message catalogs (lib/i18n.ts). zh-CN is the
 * source: each area module declares its Chinese messages `as const`, and
 * its English messages must have exactly the same keys. Placeholders are
 * `{name}`; English may write `{name, plural, one {…} other {…}}` with `#`
 * for the number, where Chinese has no plural forms.
 */

/** The catalog of another language for a source catalog: the same keys. */
export type Translation<Source> = { readonly [Key in keyof Source]: string };

/** The placeholder names of a source message. */
export type Placeholders<Text extends string> =
  Text extends `${string}{${infer Name}}${infer Rest}`
    ? Name | Placeholders<Rest>
    : never;
