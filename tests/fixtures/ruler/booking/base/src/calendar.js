import { contains, makeRange, overlaps } from "./range.js";

export class Calendar {
  constructor() {
    this.bookings = [];
  }

  book(title, start, end) {
    const range = makeRange(start, end);
    const clash = this.bookings.find(entry => overlaps(entry.range, range));
    if (clash) throw new Error("clashes with " + clash.title);
    this.bookings.push({ title, range });
    this.bookings.sort((a, b) => a.range.start - b.range.start);
  }

  isBusyAt(hour) {
    return this.bookings.some(entry => contains(entry.range, hour));
  }
}
