/**
 * Dependency-free reader for the DLL names a Windows PE image imports (ordinary and
 * delay-load import tables). Used to prove that a portable bundle does not rely on
 * runtimes that a brand-new Windows installation lacks (for example the Visual C++
 * redistributable).
 *
 * Only headers and the two import directories are read; nothing is executed.
 */
import { open } from "node:fs/promises";

const DOS_MAGIC = 0x5a4d; // "MZ"
const PE_SIGNATURE = 0x00004550; // "PE\0\0"
const PE32 = 0x10b;
const PE32_PLUS = 0x20b;
const IMPORT_DIRECTORY = 1;
const DELAY_IMPORT_DIRECTORY = 13;
const MAX_DESCRIPTORS = 4096;
const MAX_NAME = 260;

const machines = new Map([
  [0x014c, "x86"],
  [0x8664, "x64"],
  [0xaa64, "arm64"],
  [0x01c4, "arm"],
]);

/** Thrown for files that start like a PE image but cannot be parsed. */
export class PeFormatError extends Error {}

class Reader {
  constructor(handle, size) {
    this.handle = handle;
    this.size = size;
  }
  async bytes(offset, length) {
    if (offset < 0 || length < 0 || offset + length > this.size)
      throw new PeFormatError("PE structure points outside the file");
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, offset);
    if (bytesRead !== length)
      throw new PeFormatError("PE structure is truncated");
    return buffer;
  }
  async cString(offset) {
    const length = Math.min(MAX_NAME, this.size - offset);
    if (length <= 0) throw new PeFormatError("PE string is outside the file");
    const buffer = await this.bytes(offset, length);
    const end = buffer.indexOf(0);
    if (end < 0) throw new PeFormatError("PE string is not terminated");
    return buffer.subarray(0, end).toString("latin1");
  }
}

/**
 * Read the imports of one file.
 *
 * @param {string} file
 * @returns {Promise<undefined | {machine: string, imports: string[], delayImports: string[]}>}
 *   `undefined` when the file is not a PE image (no `MZ`/`PE` signatures). DLL names keep
 *   their spelling from the image. Throws {@link PeFormatError} for a damaged image.
 */
export async function readPeImports(file) {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    if (size < 0x40) return undefined;
    const reader = new Reader(handle, size);
    const dos = await reader.bytes(0, 0x40);
    if (dos.readUInt16LE(0) !== DOS_MAGIC) return undefined;
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset + 24 > size) return undefined;
    const coff = await reader.bytes(peOffset, 24);
    if (coff.readUInt32LE(0) !== PE_SIGNATURE) return undefined;
    const machineId = coff.readUInt16LE(4);
    const sectionCount = coff.readUInt16LE(6);
    const optionalSize = coff.readUInt16LE(20);
    const optionalOffset = peOffset + 24;
    const optional = await reader.bytes(optionalOffset, optionalSize);
    const magic = optional.readUInt16LE(0);
    if (magic !== PE32 && magic !== PE32_PLUS)
      throw new PeFormatError("Unknown PE optional header");
    const imageBase =
      magic === PE32_PLUS
        ? optional.readBigUInt64LE(24)
        : BigInt(optional.readUInt32LE(28));
    const directoriesOffset = magic === PE32_PLUS ? 112 : 96;
    const directoryCount = optional.readUInt32LE(directoriesOffset - 4);
    const directory = (index) => {
      const at = directoriesOffset + index * 8;
      if (index >= directoryCount || at + 8 > optional.length)
        return { rva: 0, size: 0 };
      return {
        rva: optional.readUInt32LE(at),
        size: optional.readUInt32LE(at + 4),
      };
    };
    const sectionTable = await reader.bytes(
      optionalOffset + optionalSize,
      sectionCount * 40,
    );
    const sections = [];
    for (let index = 0; index < sectionCount; index++) {
      const at = index * 40;
      sections.push({
        virtualSize: sectionTable.readUInt32LE(at + 8),
        virtualAddress: sectionTable.readUInt32LE(at + 12),
        rawSize: sectionTable.readUInt32LE(at + 16),
        rawOffset: sectionTable.readUInt32LE(at + 20),
      });
    }
    const offsetOf = (rva) => {
      for (const section of sections) {
        const span = Math.max(section.virtualSize, section.rawSize);
        if (
          rva >= section.virtualAddress &&
          rva < section.virtualAddress + span
        ) {
          const delta = rva - section.virtualAddress;
          // Bytes beyond the raw data exist only in memory (zero filled).
          if (delta >= section.rawSize) return undefined;
          return section.rawOffset + delta;
        }
      }
      return undefined;
    };
    const names = async (start, entrySize, nameAt) => {
      const result = [];
      if (!start.rva) return result;
      const base = offsetOf(start.rva);
      if (base === undefined) return result;
      for (let index = 0; index < MAX_DESCRIPTORS; index++) {
        const at = base + index * entrySize;
        if (at + entrySize > size) break;
        const entry = await reader.bytes(at, entrySize);
        if (entry.every((byte) => byte === 0)) break;
        const rva = nameAt(entry);
        if (!rva) break;
        const nameOffset = offsetOf(rva);
        if (nameOffset === undefined) continue;
        const name = await reader.cString(nameOffset);
        if (name) result.push(name);
      }
      return result;
    };
    const imports = await names(directory(IMPORT_DIRECTORY), 20, (entry) =>
      entry.readUInt32LE(12),
    );
    const delayImports = await names(
      directory(DELAY_IMPORT_DIRECTORY),
      32,
      (entry) => {
        const attributes = entry.readUInt32LE(0);
        const value = entry.readUInt32LE(4);
        // Old descriptors (attributes bit 0 clear) store virtual addresses.
        if (attributes & 1) return value;
        const rva = BigInt(value) - imageBase;
        return rva > 0n && rva < 0xffffffffn ? Number(rva) : 0;
      },
    );
    return {
      machine: machines.get(machineId) ?? `0x${machineId.toString(16)}`,
      imports,
      delayImports,
    };
  } finally {
    await handle.close();
  }
}

/** API-set contracts are resolved by the Windows loader, not by files on disk. */
export function isApiSet(name) {
  return /^(api|ext)-ms-/i.test(name);
}

/**
 * Whether a DLL belongs to a redistributable Microsoft C/C++ runtime that is NOT part of
 * Windows itself (Visual C++ 2015-2022 `*140*`, older `msvcr*`/`msvcp*`, OpenMP, MFC, ATL).
 * `ucrtbase.dll` is excluded: the Universal CRT ships with Windows 10 and later.
 */
export function isRedistributableRuntime(name) {
  return /^(vcruntime\d+(_\d+)?|msvcp\d+(_\d+|_atomic_wait|_codecvt_ids)?|msvcr\d+|concrt\d+|vccorlib\d+|vcomp\d+|vcamp\d+|mfc\d+u?|mfcm\d+u?|atl\d+)\.dll$/i.test(
    name,
  );
}
