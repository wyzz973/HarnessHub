import { rangeLabel } from "./format.js";

// Counts the hours of the day (0 to 23, both ends included) in which something is booked.
export function busyHours(calendar, firstHour = 0, lastHour = 23) {
  let count = 0;
  for (let hour = firstHour; hour <= lastHour; hour++) {
    if (calendar.isBusyAt(hour)) count++;
  }
  return count;
}

export function renderDay(calendar) {
  return calendar.bookings.map(entry => rangeLabel(entry.range) + " " + entry.title).join("\n");
}
