// outlook_mail / outlook_event / outlook_read: classic Outlook through COM automation.
import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { marked } from "marked";
import { finish, inputFile, parse, readText, ToolError } from "./common.mjs";
import { CONNECT, EVENT, MAIL, READ } from "./outlook-scripts.mjs";
import { powershell, requireWindows } from "./win.mjs";

const mailUsage = `
outlook_mail --to <a@example.com> [--to ...] --subject 主题 (--body "正文" | --body-file <body.txt|.md|.html>)
  [--cc ...] [--bcc ...] [--attach <file> ...] [--mode send|draft|display]
Creates the message in the installed classic Outlook. mode send (default) sends it, draft saves
it to Drafts, display opens the compose window for the user. Addresses may be separated by ;
Needs classic Outlook with a mail profile; otherwise use eml_create + app_open.`;
const eventUsage = `
outlook_event --subject 主题 --start "2026-09-21 14:00" [--end "2026-09-21 15:00" | --duration 60]
  [--all-day] [--location 地点] [--body 说明 | --body-file <file>] [--attendee <a@example.com> ...]
  [--reminder 15] [--mode save|send|display]
Creates an appointment in the Outlook calendar (local time). With attendees it becomes a
meeting; mode send sends the invitations. Without classic Outlook use ics_create + app_open.`;
const readUsage = `
outlook_read [--folder inbox|sent|drafts|outbox|calendar|contacts|tasks] [--top 10] [--unread]
  [--search 关键字] [--with-body] [--since 2026-09-20] [--days 7]
Lists items of the default Outlook folders as JSON (newest first; calendar: from --since for
--days days, recurring events expanded).`;

function addressList(values) {
  return (values ?? [])
    .flatMap((value) => String(value).split(/[;；,，]/))
    .map((value) => value.trim())
    .filter(Boolean);
}
function localTime(value, label) {
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2})[:：](\d{2}))?/.exec(String(value ?? "").trim());
  if (!match) throw new ToolError("BAD_TIME", `${label}: use "YYYY-MM-DD HH:mm"`);
  const [, y, m, d, hh = "0", mm = "0"] = match;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")} ${hh.padStart(2, "0")}:${mm}`;
}
async function temporary(text, extension) {
  const file = path.join(os.tmpdir(), `hh-office-${randomBytes(8).toString("hex")}${extension}`);
  await writeFile(file, `\uFEFF${text}`, "utf8");
  return file;
}
async function bodyFiles(values) {
  if (values.body !== undefined) return { textFile: await temporary(values.body, ".txt") };
  if (!values["body-file"]) return {};
  const file = await inputFile(values["body-file"], "body");
  const text = await readText(file);
  if (/\.html?$/i.test(file)) return { htmlFile: await temporary(text, ".html") };
  if (/\.(md|markdown)$/i.test(file))
    return {
      htmlFile: await temporary(
        `<html><body style="font-family:'Microsoft YaHei',Segoe UI,sans-serif;font-size:14px;line-height:1.6">${marked.parse(text, { gfm: true })}</body></html>`,
        ".html",
      ),
    };
  return { textFile: await temporary(text, ".txt") };
}
const compact = (value) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));

export async function outlookMail(argv) {
  const { values } = parse(
    argv,
    {
      to: { type: "string", multiple: true },
      cc: { type: "string", multiple: true },
      bcc: { type: "string", multiple: true },
      subject: { type: "string" },
      body: { type: "string" },
      "body-file": { type: "string" },
      attach: { type: "string", multiple: true },
      mode: { type: "string", default: "send" },
    },
    mailUsage,
  );
  requireWindows("outlook_mail");
  const to = addressList(values.to);
  if (!to.length || !values.subject)
    throw new ToolError("USAGE", "--to and --subject are required", mailUsage.trim());
  if (!["send", "draft", "display"].includes(values.mode))
    throw new ToolError("USAGE", "--mode must be send, draft or display");
  if (values.body === undefined && !values["body-file"])
    throw new ToolError("USAGE", "Pass --body or --body-file", mailUsage.trim());
  const attachments = [];
  for (const item of values.attach ?? []) attachments.push(await inputFile(item, "attachment"));
  const files = await bodyFiles(values);
  try {
    const { ok: _ok, ...rest } = await powershell(CONNECT + MAIL, {
      to,
      cc: addressList(values.cc),
      bcc: addressList(values.bcc),
      subject: values.subject,
      attachments,
      mode: values.mode,
      textFile: files.textFile ?? null,
      htmlFile: files.htmlFile ?? null,
    });
    finish(compact(rest));
  } finally {
    for (const file of Object.values(files)) await rm(file, { force: true });
  }
}

export async function outlookEvent(argv) {
  const { values } = parse(
    argv,
    {
      subject: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      duration: { type: "string", default: "60" },
      "all-day": { type: "boolean", default: false },
      location: { type: "string" },
      body: { type: "string" },
      "body-file": { type: "string" },
      attendee: { type: "string", multiple: true },
      reminder: { type: "string" },
      mode: { type: "string", default: "save" },
    },
    eventUsage,
  );
  requireWindows("outlook_event");
  if (!values.subject || !values.start)
    throw new ToolError("USAGE", "--subject and --start are required", eventUsage.trim());
  if (!["save", "send", "display"].includes(values.mode))
    throw new ToolError("USAGE", "--mode must be save, send or display");
  const files = await bodyFiles(values);
  try {
    const { ok: _ok, ...rest } = await powershell(CONNECT + EVENT, {
      subject: values.subject,
      start: localTime(values.start, "--start"),
      end: values.end ? localTime(values.end, "--end") : null,
      duration: Math.max(1, Number(values.duration) || 60),
      allDay: values["all-day"],
      location: values.location ?? null,
      textFile: files.textFile ?? files.htmlFile ?? null,
      attendees: addressList(values.attendee),
      reminder: values.reminder === undefined ? null : Math.max(0, Number(values.reminder) || 0),
      mode: values.mode,
    });
    finish(compact(rest));
  } finally {
    for (const file of Object.values(files)) await rm(file, { force: true });
  }
}

export async function outlookRead(argv) {
  const { values } = parse(
    argv,
    {
      folder: { type: "string", default: "inbox" },
      top: { type: "string", default: "10" },
      unread: { type: "boolean", default: false },
      search: { type: "string" },
      "with-body": { type: "boolean", default: false },
      since: { type: "string" },
      days: { type: "string", default: "7" },
    },
    readUsage,
  );
  requireWindows("outlook_read");
  const folders = ["inbox", "sent", "drafts", "outbox", "deleted", "calendar", "contacts", "tasks"];
  if (!folders.includes(values.folder))
    throw new ToolError("USAGE", `--folder must be one of ${folders.join(", ")}`);
  const { ok: _ok, ...rest } = await powershell(CONNECT + READ, {
    folder: values.folder,
    top: Math.min(100, Math.max(1, Number(values.top) || 10)),
    unread: values.unread,
    search: values.search ?? null,
    withBody: values["with-body"],
    since: values.since ? localTime(values.since, "--since").slice(0, 10) : null,
    days: Math.min(366, Math.max(1, Number(values.days) || 7)),
  });
  finish(rest);
}
