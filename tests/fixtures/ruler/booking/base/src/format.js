export function hourLabel(hour) {
  return String(hour).padStart(2, "0") + ":00";
}

export function rangeLabel(range) {
  return hourLabel(range.start) + "-" + hourLabel(range.end);
}
