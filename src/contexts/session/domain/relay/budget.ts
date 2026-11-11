/**
 * The relay's estimator and budget (ADR-055 §6.2, slimmed 2026-11-11): one deterministic token estimate for every model
 * family and the one cap a packet is folded to, resolved here and nowhere else. Pure; nothing here reads a clock, a store or
 * a process.
 */

/**
 * The policy every packet of this renderer belongs to. A change to a template, an escape or redaction rule, an estimator
 * coefficient, a cap or the Unicode tables of the running Node changes what is rendered and must change this version.
 * relay/1-mvp.4: facts only and two tiers (complete, brief), whole items or none, a ledger that adds up.
 */
export const RELAY_POLICY_VERSION = "relay/1-mvp.4";

/**
 * What the one cap of a packet is made of: T = min(8,000, 5% of the target's context window), the window assumed when the
 * target never reported one, and the share of T the user's earlier words may take before replies and outputs are chosen (U).
 * Only the window and the channel lower T (windows.ts hardCap); what a handoff costs in money or time decides nothing.
 */
export const RELAY_BUDGET = Object.freeze({
  standardCap: 8000,
  windowShare: 0.05,
  assumedWindow: 128_000,
  userCap: 2500,
});

/** A Han, kana, Hangul, CJK punctuation or full-width code point: what the estimate and the language choice count apart. */
export function cjk(code: number): boolean {
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0xff00 && code <= 0xffef) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x3130 && code <= 0x318f) || (code >= 0x31f0 && code <= 0x31ff) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x20000 && code <= 0x3134f);
}

/**
 * The tokens a text is estimated to take, the same for every model family: ASCII bytes at 3.2 per token, CJK characters
 * (see `cjk`) at 1.3 tokens each, and the UTF-8 bytes of everything else at 2.4 per token, rounded up. It errs high for the
 * tokenizers the design measured (o200k and Claude's), so what it admits stays within the budget it was measured against.
 * Linear in the text; the estimate of a concatenation never exceeds the sum of its parts' estimates.
 */
export function estimateTokens(text: string): number {
  let ascii = 0, wide = 0, other = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) { ascii++; continue; }
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        index++;
        if (cjk(((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000)) wide++; else other += 4;
        continue;
      }
    }
    if (cjk(code)) wide++; else other += code < 0x800 ? 2 : 3;
  }
  return Math.ceil(ascii / 3.2 + wide * 1.3 + other / 2.4);
}

/** What a packet may take (ADR-055 §6.2), in tokens of `estimateTokens`. */
export interface RelayBudget {
  /** T: the whole packet, its frame, the history it carries and its ledger. */
  readonly cap: number;
  /** U: the user's earlier words, chosen before replies and outputs, up to this much (the latest one may take more if it fits). */
  readonly user: number;
  /** The target's context window the cap was derived from, and whether the target reported it or it was assumed. */
  readonly window: number;
  readonly windowSource: "observed" | "assumed";
}

/**
 * The budget for a target whose context window is `window` tokens (its latest reported `usage.context.size`), or the assumed
 * 128k when it reported none or reported something that is not a positive whole number. The cap never exceeds 8,000 tokens
 * nor 5% of the window; the history's length never enters it, so no history is too long for it (the packet leaves out whole
 * items instead).
 */
export function resolveRelayBudget(window: number | null): RelayBudget {
  const observed = window !== null && Number.isSafeInteger(window) && window > 0;
  const size = observed ? window : RELAY_BUDGET.assumedWindow;
  const cap = Math.min(RELAY_BUDGET.standardCap, Math.floor(RELAY_BUDGET.windowShare * size));
  return { cap, user: Math.min(RELAY_BUDGET.userCap, Math.floor(0.5 * cap)), window: size, windowSource: observed ? "observed" : "assumed" };
}
