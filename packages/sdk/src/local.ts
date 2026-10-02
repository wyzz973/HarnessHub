// SPDX-License-Identifier: MIT
/**
 * Connecting to the daemon on this machine (Node only): the admin token is
 * read from `<dataDir>/admin.token`, which the daemon creates with mode 0600
 * (07-data-security section 5.2). The token never travels through argv or
 * the environment.
 */
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { HarnessHubClient, type ClientOptions } from "./client.js";

/** The daemon's default loopback address (06 section 1). */
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:3180";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** No usable admin token was found in the data directory. */
export class AdminTokenUnavailableError extends Error {
  constructor(file: string, reason: string) {
    super(`Cannot read the admin token ${file}: ${reason}`);
    this.name = "AdminTokenUnavailableError";
  }
}

/**
 * Read the admin token of the daemon whose data directory is `dataDir`. The
 * file must be a regular file (not a symbolic link) and, on POSIX, private
 * to this user.
 *
 * @throws AdminTokenUnavailableError when it is missing, exposed or malformed.
 */
export async function readAdminToken(dataDir: string): Promise<string> {
  const file = path.join(path.resolve(dataDir), "admin.token");
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw new AdminTokenUnavailableError(
      file,
      typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
        ? "it does not exist; is the daemon started with this data directory?"
        : "it cannot be opened as a regular file",
    );
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024)
      throw new AdminTokenUnavailableError(file, "it is not a token file");
    if (
      process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
    )
      throw new AdminTokenUnavailableError(
        file,
        "it must belong to this user with mode 0600",
      );
    const token = (await handle.readFile("utf8")).trim();
    if (!TOKEN.test(token))
      throw new AdminTokenUnavailableError(file, "it holds no valid token");
    return token;
  } finally {
    await handle.close();
  }
}

/**
 * A client for the local daemon: `token` when given, otherwise the token in
 * `dataDir`; `url` defaults to `DEFAULT_DAEMON_URL`.
 */
export async function connectLocal(options: {
  dataDir?: string;
  url?: string | URL;
  token?: string;
  fetch?: ClientOptions["fetch"];
}): Promise<HarnessHubClient> {
  let token = options.token;
  if (token === undefined) {
    if (options.dataDir === undefined)
      throw new TypeError("connectLocal needs a token or a data directory");
    token = await readAdminToken(options.dataDir);
  }
  return new HarnessHubClient({
    url: options.url ?? DEFAULT_DAEMON_URL,
    token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
