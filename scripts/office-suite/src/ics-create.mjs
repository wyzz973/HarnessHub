// ics_create: calendar events (RFC 5545) that Outlook, WPS and phone calendars import.
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { finish, inputFile, outputFile, parse, readText, ToolError } from "./common.mjs";

const usage = `
ics_create --output <file.ics> --title 标题 --start "2026-09-21 14:00" [--end "2026-09-21 15:00" | --duration 60]
  [--all-day] [--location 地点] [--description 说明] [--attendee "张三 <zhangsan@example.com>" ...]
  [--organizer "李四 <lisi@example.com>"] [--reminder 15] [--rrule "FREQ=WEEKLY;COUNT=10"]
  [--tz Asia/Shanghai]
  or: ics_create --output <file.ics> --input events.json   (array of objects with the same keys)
Times are local wall-clock times of --tz (default: this computer's time zone) and are stored
as UTC, so every calendar shows the right moment. Double-click / app_open the .ics to import.`;

function zoneOffset(instant, zone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return (
    Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) -
    Math.floor(instant / 1000) * 1000
  );
}

/** "2026-09-21 14:00" in `zone` -> epoch milliseconds. */
export function wallTime(text, zone) {
  const match =
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?)?$/.exec(
      String(text).trim(),
    );
  if (!match)
    throw new ToolError("BAD_TIME", `Cannot read time "${text}"; use "YYYY-MM-DD HH:mm"`);
  const [, y, m, d, hh = "0", mm = "0", ss = "0"] = match;
  const guess = Date.UTC(+y, +m - 1, +d, +hh, +mm, +ss);
  const first = guess - zoneOffset(guess, zone);
  return { instant: guess - zoneOffset(first, zone), dateOnly: match[4] === undefined, parts: [+y, +m, +d] };
}

const pad = (value, size = 2) => String(value).padStart(size, "0");
function utcStamp(instant) {
  const date = new Date(instant);
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}
function dateStamp([y, m, d], addDays = 0) {
  const date = new Date(Date.UTC(y, m - 1, d + addDays));
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}
function escapeText(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}
/** Fold at 75 octets without cutting a UTF-8 sequence. */
function fold(line) {
  const output = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char);
    if (bytes + size > (output.length ? 74 : 75)) {
      output.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  output.push(current);
  return output.map((part, index) => (index ? ` ${part}` : part)).join("\r\n");
}
function person(value) {
  const match = /^\s*(?:"?([^"<]*?)"?\s*)?<?([^\s<>]+@[^\s<>]+)>?\s*$/.exec(String(value));
  if (!match) throw new ToolError("BAD_ADDRESS", `Cannot read address "${value}"; use "姓名 <mail@example.com>"`);
  return { name: match[1]?.trim(), email: match[2] };
}

function eventLines(event, zone, stamp) {
  if (!event.title) throw new ToolError("USAGE", "Every event needs a title", usage.trim());
  if (!event.start) throw new ToolError("USAGE", "Every event needs a start time", usage.trim());
  const start = wallTime(event.start, event.tz ?? zone);
  const allDay = Boolean(event.allDay ?? event["all-day"]) || start.dateOnly;
  const lines = ["BEGIN:VEVENT", `UID:${event.uid ?? `${randomUUID()}@harnesshub`}`, `DTSTAMP:${stamp}`];
  if (allDay) {
    const end = event.end ? wallTime(event.end, event.tz ?? zone) : start;
    lines.push(`DTSTART;VALUE=DATE:${dateStamp(start.parts)}`, `DTEND;VALUE=DATE:${dateStamp(end.parts, 1)}`);
  } else {
    const end = event.end
      ? wallTime(event.end, event.tz ?? zone).instant
      : start.instant + (Number(event.duration ?? 60) || 60) * 60000;
    if (end <= start.instant) throw new ToolError("BAD_TIME", "The end must be after the start");
    lines.push(`DTSTART:${utcStamp(start.instant)}`, `DTEND:${utcStamp(end)}`);
  }
  lines.push(`SUMMARY:${escapeText(event.title)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.organizer) {
    const organizer = person(event.organizer);
    lines.push(`ORGANIZER${organizer.name ? `;CN=${escapeText(organizer.name)}` : ""}:mailto:${organizer.email}`);
  }
  for (const item of [event.attendee ?? event.attendees ?? []].flat()) {
    const attendee = person(item);
    lines.push(
      `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE${attendee.name ? `;CN=${escapeText(attendee.name)}` : ""}:mailto:${attendee.email}`,
    );
  }
  if (event.rrule) lines.push(`RRULE:${String(event.rrule).replace(/^RRULE:/i, "")}`);
  lines.push("STATUS:CONFIRMED", "SEQUENCE:0", "TRANSP:OPAQUE");
  const reminder = event.reminder === undefined || event.reminder === "" ? undefined : Number(event.reminder);
  if (Number.isFinite(reminder) && reminder >= 0)
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(event.title)}`, `TRIGGER:-PT${Math.round(reminder)}M`, "END:VALARM");
  lines.push("END:VEVENT");
  return lines;
}

export async function icsCreate(argv) {
  const { values } = parse(
    argv,
    {
      output: { type: "string" },
      input: { type: "string" },
      title: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      duration: { type: "string" },
      "all-day": { type: "boolean", default: false },
      location: { type: "string" },
      description: { type: "string" },
      attendee: { type: "string", multiple: true },
      organizer: { type: "string" },
      reminder: { type: "string" },
      rrule: { type: "string" },
      tz: { type: "string" },
    },
    usage,
  );
  if (!values.output) throw new ToolError("USAGE", "--output is required", usage.trim());
  const zone = values.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new ToolError("BAD_TIMEZONE", `Unknown time zone "${zone}"; use an IANA name such as Asia/Shanghai`);
  }
  let events;
  if (values.input) {
    try {
      events = JSON.parse(await readText(await inputFile(values.input)));
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("BAD_JSON", error.message);
    }
    if (!Array.isArray(events)) events = [events];
  } else events = [{ ...values, allDay: values["all-day"] }];
  const output = await outputFile(values.output, ".ics");
  const stamp = utcStamp(Date.now());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HarnessHub//office-suite//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...events.flatMap((event) => eventLines(event, zone, stamp)),
    "END:VCALENDAR",
  ];
  await writeFile(output, `${lines.map(fold).join("\r\n")}\r\n`, "utf8");
  finish({ output, events: events.length, timeZone: zone });
}
