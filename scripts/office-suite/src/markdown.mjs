// Markdown front end shared by the Word, PowerPoint and PDF writers.
import { marked } from "marked";

/** Block tokens of a Markdown text (GitHub flavoured: tables, task lists, strikethrough). */
export function blocks(markdown) {
  return marked.lexer(markdown.replace(/\r\n?/g, "\n"), { gfm: true });
}

/** Plain text of inline tokens (used for table cells in spreadsheets, slide titles, ...). */
export function plain(tokens) {
  let text = "";
  for (const token of tokens ?? []) {
    if (token.type === "br") text += "\n";
    else if (token.type === "image") text += token.text ?? "";
    else if (token.tokens?.length) text += plain(token.tokens);
    else text += unescape(token.text ?? token.raw ?? "");
  }
  return text;
}

/** marked escapes HTML entities in `text`; office writers need the characters. */
export function unescape(text) {
  return String(text)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

/**
 * Flatten inline tokens into styled runs:
 * {text, bold, italic, strike, code, link, break, image:{href,alt}}.
 */
export function runs(tokens, style = {}) {
  const result = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "strong":
        result.push(...runs(token.tokens, { ...style, bold: true }));
        break;
      case "em":
        result.push(...runs(token.tokens, { ...style, italic: true }));
        break;
      case "del":
        result.push(...runs(token.tokens, { ...style, strike: true }));
        break;
      case "codespan":
        result.push({ ...style, code: true, text: unescape(token.text) });
        break;
      case "link":
        result.push(...runs(token.tokens, { ...style, link: token.href }));
        break;
      case "image":
        result.push({ ...style, image: { href: token.href, alt: token.text } });
        break;
      case "br":
        result.push({ ...style, break: true, text: "" });
        break;
      case "html":
        if (/^<br\s*\/?>(\n)?$/i.test(token.raw))
          result.push({ ...style, break: true, text: "" });
        break;
      case "escape":
        result.push({ ...style, text: unescape(token.text) });
        break;
      default:
        if (token.tokens?.length) result.push(...runs(token.tokens, style));
        else {
          // Soft line breaks inside a paragraph are spaces in Latin text and nothing
          // between CJK characters.
          const text = unescape(token.text ?? token.raw ?? "").replace(
            /\s*\n\s*/g,
            (match, offset, whole) => {
              const before = whole[offset - 1] ?? "";
              const after = whole[offset + match.length] ?? "";
              return /[\u2e80-\u9fff\uff00-\uffef]/.test(before) &&
                /[\u2e80-\u9fff\uff00-\uffef]/.test(after)
                ? ""
                : " ";
            },
          );
          if (text) result.push({ ...style, text });
        }
    }
  }
  return result;
}

/** Pixel size of a PNG, JPEG, GIF or BMP image; undefined for anything else. */
export function imageSize(bytes) {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47)
    return { type: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length > 10 && bytes.toString("ascii", 0, 3) === "GIF")
    return { type: "gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length > 26 && bytes.toString("ascii", 0, 2) === "BM")
    return {
      type: "bmp",
      width: bytes.readInt32LE(18),
      height: Math.abs(bytes.readInt32LE(22)),
    };
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      )
        return {
          type: "jpg",
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7),
        };
      offset += 2 + length;
    }
  }
  return undefined;
}
