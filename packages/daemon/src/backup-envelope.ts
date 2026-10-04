// SPDX-License-Identifier: MIT
/**
 * The sealed file of backups and sync (docs/backup-sync.md): a JSON envelope
 * naming how the content is sealed, and the content encrypted with
 * AES-256-GCM under a key derived from a passphrase with PBKDF2-SHA256. The
 * envelope's own fields are the additional authenticated data, so none of
 * them can be changed unnoticed. The format follows Magpie's backup file
 * (yetone/magpie, MIT, internal/backup).
 */
import {
  createCipheriv,
  createDecipheriv,
  pbkdf2,
  randomBytes,
} from "node:crypto";
import { promisify } from "node:util";
import { HubError } from "@harnesshub/core/errors";

const derive = promisify(pbkdf2);

/** The envelope's `format`, and the extension sealed files are saved with. */
export const BACKUP_FORMAT = "harnesshub-backup";
export const BACKUP_EXTENSION = ".harnesshub-backup";

/** OWASP's 2023 count for PBKDF2-SHA256, as Magpie uses. */
export const BACKUP_ITERATIONS = 600_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** A sealed file larger than this is refused before any work. */
export const MAX_SEALED_BYTES = 64 * 1024 * 1024;

/** The sealed file as JSON. Binary fields are base64. */
export interface BackupEnvelope {
  format: typeof BACKUP_FORMAT;
  version: 1;
  kdf: "pbkdf2-sha256";
  iterations: number;
  salt: string;
  nonce: string;
  /** The ciphertext followed by the 16-byte GCM tag. */
  data: string;
}

/**
 * The content of a sealed file was not readable: `BACKUP_PASSPHRASE` (400)
 * for a wrong passphrase or changed bytes, which GCM cannot tell apart;
 * `BACKUP_INVALID` (400) for something that is not a sealed file;
 * `BACKUP_UNSUPPORTED` (400) for a newer format version.
 */
export class BackupError extends HubError {
  constructor(
    code: "BACKUP_PASSPHRASE" | "BACKUP_INVALID" | "BACKUP_UNSUPPORTED",
    message: string,
  ) {
    super(code, message, 400);
    this.name = "BackupError";
  }
}

/**
 * Encrypts `plain` under `passphrase` with a fresh salt and nonce. Deriving
 * the key takes PBKDF2's 600,000 rounds off the event loop.
 *
 * @throws BackupError `BACKUP_INVALID` for an empty passphrase.
 */
export async function seal(
  plain: Buffer,
  passphrase: string,
  iterations = BACKUP_ITERATIONS,
): Promise<BackupEnvelope> {
  if (!passphrase)
    throw new BackupError("BACKUP_INVALID", "A backup needs a passphrase");
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const header = {
    format: BACKUP_FORMAT,
    version: 1,
    kdf: "pbkdf2-sha256",
    iterations,
  } as const;
  const key = await derive(passphrase, salt, iterations, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(additionalData(header.iterations, salt));
  const data = Buffer.concat([
    cipher.update(plain),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    ...header,
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    data: data.toString("base64"),
  };
}

/**
 * Decrypts a sealed file given as parsed JSON (`unknown`: it comes from a
 * file, a request or a server).
 *
 * @throws BackupError `BACKUP_INVALID` when it is not a sealed file or its
 *   parameters are out of range (iterations 100,000 to 10,000,000, a 12-byte
 *   nonce, a salt of 16 bytes or more); `BACKUP_UNSUPPORTED` for another
 *   version or KDF; `BACKUP_PASSPHRASE` when the passphrase does not open it
 *   or any byte of it, envelope fields included, was changed.
 */
export async function open(
  envelope: unknown,
  passphrase: string,
): Promise<Buffer> {
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    Array.isArray(envelope) ||
    !("format" in envelope) ||
    envelope.format !== BACKUP_FORMAT
  )
    throw new BackupError("BACKUP_INVALID", "This is not a HarnessHub backup");
  const fields = envelope as Record<string, unknown>;
  if (fields.version !== 1 || fields.kdf !== "pbkdf2-sha256")
    throw new BackupError(
      "BACKUP_UNSUPPORTED",
      "This backup was made by a newer HarnessHub; update HarnessHub to open it",
    );
  const iterations = fields.iterations;
  const salt = bytes(fields.salt);
  const nonce = bytes(fields.nonce);
  const data = bytes(fields.data);
  if (
    typeof iterations !== "number" ||
    !Number.isSafeInteger(iterations) ||
    iterations < MIN_ITERATIONS ||
    iterations > MAX_ITERATIONS ||
    !salt ||
    salt.length < SALT_BYTES ||
    !nonce ||
    nonce.length !== NONCE_BYTES ||
    !data ||
    data.length < TAG_BYTES
  )
    throw new BackupError("BACKUP_INVALID", "This is not a HarnessHub backup");
  const key = await derive(passphrase, salt, iterations, 32, "sha256");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(additionalData(iterations, salt));
  decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(data.subarray(0, data.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw new BackupError(
      "BACKUP_PASSPHRASE",
      "Wrong passphrase, or the file was changed",
    );
  }
}

/** Parses the bytes of a sealed file; refuses what is too large or not JSON. */
export function parseEnvelope(bytes: Buffer | string): unknown {
  const text = typeof bytes === "string" ? bytes : bytes.toString("utf8");
  if (Buffer.byteLength(text) > MAX_SEALED_BYTES)
    throw new BackupError("BACKUP_INVALID", "The backup is too large");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BackupError("BACKUP_INVALID", "This is not a HarnessHub backup");
  }
}

/** The bytes a sealed file is written as. */
export function formatEnvelope(envelope: BackupEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/** `<format>/<version>/<kdf>/<iterations>/<salt hex>`, as Magpie's header. */
function additionalData(iterations: number, salt: Buffer): Buffer {
  return Buffer.from(
    `${BACKUP_FORMAT}/1/pbkdf2-sha256/${iterations}/${salt.toString("hex")}`,
  );
}

/** Strict base64 to bytes; undefined for anything else. */
function bytes(value: unknown): Buffer | undefined {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    return undefined;
  return Buffer.from(value, "base64");
}
