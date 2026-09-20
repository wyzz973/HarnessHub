/**
 * Dependency-free ZIP reader and writer for the competition task suite
 * (scripts/competition-tasks.mjs). Office documents (docx/xlsx/pptx) and the archives
 * agents produce are ordinary ZIP files; only `node:zlib` is needed to check them.
 *
 * Reader: central-directory based, methods 0 (stored) and 8 (deflate), CRC-32 verified,
 * bounded sizes. ZIP64, encryption and multi-disk archives are rejected with a clear
 * error instead of being misread. Writer: deterministic (fixed timestamp), UTF-8 names.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** Largest single entry the reader inflates. */
export const ZIP_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** Largest number of entries the reader lists. */
export const ZIP_MAX_ENTRIES = 20_000;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE) of a buffer as an unsigned 32-bit integer. */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index++)
    crc = crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipError(message) {
  return Object.assign(new Error(message), { code: "INVALID_ZIP" });
}

/** Entry names without the UTF-8 flag are usually CP437 or, on Chinese Windows, GBK. */
function decodeName(bytes, utf8) {
  if (utf8) return bytes.toString("utf8");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("gbk", { fatal: true }).decode(bytes);
    } catch {
      return bytes.toString("latin1");
    }
  }
}

/**
 * Parse a ZIP archive held in memory.
 *
 * @param {Buffer} buffer Whole archive.
 * @returns {{entries: {name: string, directory: boolean, method: number, size: number,
 *   compressedSize: number, crc32: number}[], read: (name: string) => Buffer,
 *   has: (name: string) => boolean}} `read` inflates one entry and verifies its CRC-32;
 *   it throws `INVALID_ZIP` for unknown names, unsupported methods or corrupt data.
 *   Names use `/` separators exactly as stored (a leading `./` or `/` is stripped).
 * @throws {Error & {code: "INVALID_ZIP"}} When the buffer is not a readable ZIP.
 */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < 22)
    throw zipError("File is too small to be a ZIP archive");
  let end = -1;
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= lowest; offset--)
    if (buffer.readUInt32LE(offset) === EOCD) {
      end = offset;
      break;
    }
  if (end < 0) throw zipError("ZIP end-of-central-directory record not found");
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0)
    throw zipError("Multi-disk ZIP archives are not supported");
  const total = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (
    total === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  )
    throw zipError("ZIP64 archives are not supported");
  if (total > ZIP_MAX_ENTRIES)
    throw zipError(`ZIP has more than ${ZIP_MAX_ENTRIES} entries`);
  if (directoryOffset + directorySize > end)
    throw zipError("ZIP central directory is outside the file");

  const entries = [];
  const index = new Map();
  let offset = directoryOffset;
  for (let count = 0; count < total; count++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL)
      throw zipError("ZIP central directory entry is corrupt");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const name = decodeName(rawName, (flags & 0x0800) !== 0)
      .replaceAll("\\", "/")
      .replace(/^(?:\.\/|\/)+/, "");
    const entry = {
      name,
      directory: name.endsWith("/"),
      method,
      size,
      compressedSize,
      crc32: crc,
    };
    entries.push(entry);
    index.set(name, { ...entry, flags, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  const read = (name) => {
    const entry = index.get(name);
    if (!entry) throw zipError(`ZIP entry not found: ${name}`);
    if (entry.flags & 0x0001) throw zipError(`ZIP entry is encrypted: ${name}`);
    if (entry.size > ZIP_MAX_ENTRY_BYTES)
      throw zipError(`ZIP entry is larger than the reader limit: ${name}`);
    const local = entry.localOffset;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL)
      throw zipError(`ZIP local header is corrupt: ${name}`);
    const start =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    const compressed = buffer.subarray(start, start + entry.compressedSize);
    if (compressed.length !== entry.compressedSize)
      throw zipError(`ZIP entry data is truncated: ${name}`);
    let data;
    if (entry.method === 0) data = Buffer.from(compressed);
    else if (entry.method === 8)
      try {
        data = inflateRawSync(compressed, {
          maxOutputLength: ZIP_MAX_ENTRY_BYTES,
        });
      } catch (error) {
        throw zipError(
          `ZIP entry cannot be inflated: ${name} (${error.message})`,
        );
      }
    else
      throw zipError(
        `ZIP compression method ${entry.method} is not supported: ${name}`,
      );
    if (data.length !== entry.size || crc32(data) !== entry.crc32)
      throw zipError(`ZIP entry failed its size or CRC-32 check: ${name}`);
    return data;
  };
  return { entries, read, has: (name) => index.has(name) };
}

/**
 * Build a ZIP archive in memory with a fixed timestamp (1980-01-01), so the same input
 * always yields the same bytes.
 *
 * @param {{name: string, data: Buffer | string, store?: boolean}[]} files Entries in
 *   order; `store: true` keeps the entry uncompressed.
 * @returns {Buffer}
 */
export function writeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data)
      ? file.data
      : Buffer.from(file.data, "utf8");
    const stored = file.store === true || data.length === 0;
    const body = stored ? data : deflateRawSync(data);
    const method = stored ? 0 : 8;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
