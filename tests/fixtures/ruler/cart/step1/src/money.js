/** "12.34" -> 1234, "5" -> 500, "0.5" -> 50 */
export function toCents(text) {
  const [whole, fraction = ""] = String(text).trim().split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}

/** 1234 -> "12.34", 5 -> "0.05", 100 -> "1.00" */
export function formatCents(cents) {
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  return whole + "." + String(fraction).padStart(2, "0");
}
