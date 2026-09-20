// eml_create: a standards-compliant e-mail file (opens as a ready-to-send draft in Outlook).
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { marked } from "marked";
import { finish, inputFile, outputFile, parse, readText, ToolError } from "./common.mjs";

const usage = `
eml_create --output <file.eml> --to "张三 <zhangsan@example.com>" [--to ...] --subject 主题
  (--body "正文" | --body-file <body.txt|.md|.html>) [--from "我 <me@example.com>"]
  [--cc ...] [--bcc ...] [--attach <file> ...] [--sent]
Addresses may be separated by ; or , . A .md body becomes HTML with a plain-text alternative.
The file carries "X-Unsent: 1", so double-clicking it (or app_open) opens an editable draft in
Outlook; --sent writes it as an already sent message instead.`;

const MIME = {
  ".txt": "text/plain", ".csv": "text/csv", ".html": "text/html", ".htm": "text/html", ".md": "text/markdown",
  ".json": "application/json", ".xml": "application/xml", ".pdf": "application/pdf", ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword", ".xls": "application/vnd.ms-excel", ".ppt": "application/vnd.ms-powerpoint",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".bmp": "image/bmp",
  ".ics": "text/calendar", ".eml": "message/rfc822",
};

const ascii = (text) => /^[\x20-\x7e]*$/.test(text);
function encodedWord(text) {
  if (ascii(text)) return text;
  // RFC 2047: every encoded word is at most 75 characters; split on code points.
  const words = [];
  let chunk = "";
  for (const char of text) {
    if (Buffer.byteLength(chunk + char) > 39) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`).join("\r\n ");
}
function addresses(values, label) {
  const result = [];
  for (const item of (values ?? []).flatMap((value) => value.split(/[;；,，]\s*(?=[^<>]*(?:<|$))/))) {
    if (!item.trim()) continue;
    const match = /^\s*(?:"?([^"<]*?)"?\s*)?<?([^\s<>]+@[^\s<>]+)>?\s*$/.exec(item);
    if (!match)
      throw new ToolError("BAD_ADDRESS", `${label}: cannot read address "${item.trim()}"; use "姓名 <mail@example.com>"`);
    const name = match[1]?.trim();
    result.push(name ? `${ascii(name) ? `"${name.replaceAll('"', "")}"` : encodedWord(name)} <${match[2]}>` : match[2]);
  }
  return result;
}
function base64Lines(bytes) {
  return (Buffer.from(bytes).toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}
function textPart(type, text) {
  return [`Content-Type: ${type}; charset="utf-8"`, "Content-Transfer-Encoding: base64", "", base64Lines(Buffer.from(text, "utf8"))].join("\r\n");
}
const boundary = () => `----=_HarnessHub_${randomBytes(12).toString("hex")}`;
function multipart(kind, parts) {
  const mark = boundary();
  return [`Content-Type: multipart/${kind}; boundary="${mark}"`, "", ...parts.flatMap((part) => [`--${mark}`, part]), `--${mark}--`, ""].join("\r\n");
}

export async function emlCreate(argv) {
  const { values } = parse(
    argv,
    {
      output: { type: "string" },
      from: { type: "string" },
      to: { type: "string", multiple: true },
      cc: { type: "string", multiple: true },
      bcc: { type: "string", multiple: true },
      subject: { type: "string" },
      body: { type: "string" },
      "body-file": { type: "string" },
      attach: { type: "string", multiple: true },
      sent: { type: "boolean", default: false },
    },
    usage,
  );
  if (!values.output || !values.subject) throw new ToolError("USAGE", "--output and --subject are required", usage.trim());
  const to = addresses(values.to, "--to");
  if (!to.length) throw new ToolError("USAGE", "At least one --to address is required", usage.trim());
  if (values.body === undefined && !values["body-file"]) throw new ToolError("USAGE", "Pass --body or --body-file", usage.trim());
  let plain = values.body ?? "";
  let html;
  if (values["body-file"]) {
    const file = await inputFile(values["body-file"], "body");
    const text = await readText(file);
    if (/\.html?$/i.test(file)) {
      html = text;
      plain = text.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h\d>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    } else if (/\.(md|markdown)$/i.test(file)) {
      plain = text;
      html = `<html><body style="font-family:'Microsoft YaHei',Segoe UI,sans-serif;font-size:14px;line-height:1.6">${marked.parse(text, { gfm: true })}</body></html>`;
    } else plain = text;
  }
  const body = html
    ? multipart("alternative", [textPart("text/plain", plain), textPart("text/html", html)])
    : textPart("text/plain", plain);
  const attachments = [];
  for (const item of values.attach ?? []) {
    const file = await inputFile(item, "attachment");
    const name = path.basename(file);
    attachments.push(
      [
        `Content-Type: ${MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream"}; name="${ascii(name) ? name : encodedWord(name)}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${ascii(name) ? name : encodedWord(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "",
        base64Lines(await readFile(file)),
      ].join("\r\n"),
    );
  }
  const from = addresses(values.from ? [values.from] : [], "--from");
  const headers = [
    ...(from.length ? [`From: ${from[0]}`] : []),
    `To: ${to.join(",\r\n ")}`,
    ...(values.cc?.length ? [`Cc: ${addresses(values.cc, "--cc").join(",\r\n ")}`] : []),
    ...(values.bcc?.length ? [`Bcc: ${addresses(values.bcc, "--bcc").join(",\r\n ")}`] : []),
    `Subject: ${encodedWord(values.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomUUID()}@harnesshub.local>`,
    "MIME-Version: 1.0",
    ...(values.sent ? [] : ["X-Unsent: 1"]),
  ];
  const output = await outputFile(values.output, ".eml");
  const message = `${headers.join("\r\n")}\r\n${attachments.length ? multipart("mixed", [body, ...attachments]) : `${body}\r\n`}`;
  await writeFile(output, message, "utf8");
  finish({ output, to: to.length, attachments: attachments.length, draft: !values.sent, bytes: Buffer.byteLength(message) });
}
