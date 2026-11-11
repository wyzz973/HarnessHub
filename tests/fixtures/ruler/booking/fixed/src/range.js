// A range of whole hours is half-open: it includes start and excludes end.
export function makeRange(start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error("hours must be whole numbers");
  if (end <= start) throw new Error("empty range");
  return { start, end };
}

export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

export function contains(range, hour) {
  return hour >= range.start && hour < range.end;
}

export function length(range) {
  return range.end - range.start;
}
