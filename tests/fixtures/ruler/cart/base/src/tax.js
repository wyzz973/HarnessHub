import { rateFor } from "./rates.js";

export function taxFor(subtotalCents, region) {
  return Math.round(subtotalCents * rateFor(region));
}
