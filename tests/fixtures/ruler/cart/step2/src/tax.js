import { rateFor } from "./rates.js";

// rates.js mixes units: a fraction (0.07) for some regions, a percentage (19) for others.
function fractionFor(region) {
  const rate = rateFor(region);
  return rate > 1 ? rate / 100 : rate;
}

export function taxFor(subtotalCents, region) {
  return Math.round(subtotalCents * fractionFor(region));
}
