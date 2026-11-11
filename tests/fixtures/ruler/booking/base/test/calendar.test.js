import test from "node:test";
import assert from "node:assert/strict";
import { Calendar } from "../src/calendar.js";

test("book keeps the bookings in time order", () => {
  const calendar = new Calendar();
  calendar.book("review", 14, 15);
  calendar.book("standup", 9, 10);
  assert.deepEqual(calendar.bookings.map(entry => entry.title), ["standup", "review"]);
});

test("book rejects a booking that overlaps an existing one", () => {
  const calendar = new Calendar();
  calendar.book("standup", 9, 11);
  assert.throws(() => calendar.book("sync", 10, 12), /clashes with standup/);
});

test("back-to-back bookings are allowed", () => {
  const calendar = new Calendar();
  calendar.book("standup", 9, 10);
  calendar.book("review", 10, 12);
  assert.equal(calendar.bookings.length, 2);
});

test("isBusyAt is true during a booking and false well outside it", () => {
  const calendar = new Calendar();
  calendar.book("standup", 9, 10);
  assert.equal(calendar.isBusyAt(9), true);
  assert.equal(calendar.isBusyAt(7), false);
  assert.equal(calendar.isBusyAt(15), false);
});
