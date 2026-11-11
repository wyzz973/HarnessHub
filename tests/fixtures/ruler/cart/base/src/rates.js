const RATES = { US: 0.07, JP: 0.1, DE: 19, FR: 20 };

export function rateFor(region) {
  if (!(region in RATES)) throw new Error("unknown region: " + region);
  return RATES[region];
}
