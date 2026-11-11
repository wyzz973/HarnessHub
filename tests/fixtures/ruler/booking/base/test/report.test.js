import test from "node:test";
import assert from "node:assert/strict";
import { Calendar } from "../src/calendar.js";
import { busyHours, renderDay } from "../src/report.js";

test("busyHours counts each booked hour once", () => {
  const calendar = new Calendar();
  calendar.book("standup", 9, 10);
  calendar.book("review", 10, 12);
  assert.equal(busyHours(calendar), 3);
});

test("an empty calendar has no busy hours", () => {
  assert.equal(busyHours(new Calendar()), 0);
});

test("renderDay lists the bookings in time order", () => {
  const calendar = new Calendar();
  calendar.book("review", 14, 15);
  calendar.book("standup", 9, 10);
  assert.equal(renderDay(calendar), "09:00-10:00 standup\n14:00-15:00 review");
});
