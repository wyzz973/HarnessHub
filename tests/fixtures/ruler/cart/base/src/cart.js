import { taxFor } from "./tax.js";

export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.priceCents * item.qty, 0);
}

export function total(items, { region, discountCents = 0 }) {
  const sub = subtotal(items);
  const tax = taxFor(sub, region);
  return sub - discountCents + tax;
}
