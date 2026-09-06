import { WindowsFileSession } from "./windows-file-session.js";

/** Holds a native read lease, rejects existing writers, and awaits release on abort. */
export async function withWindowsReadLock<T>(
  file: string,
  signal: AbortSignal,
  read: () => Promise<T>,
): Promise<T> {
  const session = await WindowsFileSession.create(signal);
  try {
    return await session.withReadLock(file, read);
  } finally {
    await session.close();
  }
}
