import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Relative path with `/` separators; stored as UTF-8. */
  name: string;
  data: Buffer;
  modified?: Date;
}

/** Largest archive this writer produces; ZIP64 is not implemented. */
export const ZIP_LIMIT = 0xffff_fffe;

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Build a ZIP archive (deflate, UTF-8 names) readable by Windows Explorer,
 * PowerShell `Expand-Archive` and `unzip`. Entry names must be relative and
 * unique; the whole archive must stay below {@link ZIP_LIMIT} bytes and 65535
 * entries, otherwise this throws before returning partial data.
 */
export function createZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > 0xffff) throw new Error("Too many ZIP entries");
  const names = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = entry.name.replaceAll("\\", "/");
    if (!name || name.startsWith("/") || name.split("/").includes(".."))
      throw new Error(`Invalid ZIP entry name: ${entry.name}`);
    if (names.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    names.add(name);
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const checksum = crc32(entry.data);
    const { time, date } = dosTime(entry.modified ?? new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
    if (offset > ZIP_LIMIT) throw new Error("ZIP archive would exceed 4 GiB");
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  if (offset + directory.length + end.length > ZIP_LIMIT)
    throw new Error("ZIP archive would exceed 4 GiB");
  return Buffer.concat([...locals, directory, end]);
}
