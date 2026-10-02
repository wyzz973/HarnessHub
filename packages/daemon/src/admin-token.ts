// SPDX-License-Identifier: MIT
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { HubError } from "@harnesshub/core/errors";

/** The local admin token file in the data root (06 section 1, 07 section 5.2). */
export const ADMIN_TOKEN_FILE = "admin.token";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function insecure(reason: string): HubError {
  return new HubError(
    "ADMIN_TOKEN_INSECURE",
    `${ADMIN_TOKEN_FILE} ${reason}; remove it and restart to create a new one`,
    500,
  );
}

async function readToken(file: string): Promise<string | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw insecure("cannot be opened as a regular file");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024)
      throw insecure("is not a small regular file");
    if (
      process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
    )
      throw insecure("must belong to this user with mode 0600");
    const token = (await handle.readFile("utf8")).trim();
    if (!TOKEN.test(token)) throw insecure("does not hold a valid token");
    return token;
  } finally {
    await handle.close();
  }
}

/**
 * The SHA-256 of the local admin token, creating `<dataDir>/admin.token` with
 * 256 random bits (base64url, mode 0600) when it is missing. The new file is
 * written in full and hard-linked into place, so concurrent starts agree on
 * one token. The token itself is not kept: callers compare digests.
 *
 * @throws HubError `ADMIN_TOKEN_INSECURE` (500) when the existing file is a
 *   link, is readable by others (POSIX), or holds no valid token.
 */
export async function ensureAdminToken(dataDir: string): Promise<Buffer> {
  const file = path.join(dataDir, ADMIN_TOKEN_FILE);
  let token = await readToken(file);
  if (token === undefined) {
    const temporary = path.join(
      dataDir,
      `.${ADMIN_TOKEN_FILE}.${randomUUID()}`,
    );
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${randomBytes(32).toString("base64url")}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporary, file);
      } catch (error) {
        // A concurrent start created it first; its token is read below.
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "EEXIST"
        )
          throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
    token = await readToken(file);
    if (token === undefined) throw insecure("disappeared after creation");
  }
  return adminTokenDigest(token);
}

/** SHA-256 of a presented or stored admin token. */
export function adminTokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
