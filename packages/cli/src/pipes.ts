// SPDX-License-Identifier: MIT
/**
 * Standard output and error whose reader has gone: `hh console | true`, or
 * `hh usage --format csv | head`. Node fails such a write with EPIPE and,
 * with no listener, ends the process with a stack trace.
 */

/** A stream that reports its failures as `error` events, as stdout and stderr do. */
interface ErrorEmitter {
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** A writable stream {@link drained} can wait on. */
interface DrainEmitter {
  once(event: "drain", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  off(event: "drain", listener: () => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

const watched = new WeakSet<object>();

/** Whether `error` says the stream's reader has gone. */
export function readerGone(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EPIPE"
  );
}

/**
 * Lets the command go on when the reader of `streams` goes away: what it
 * writes there from then on is dropped, and it ends with its own exit code,
 * since what a command did does not depend on whether its output was read
 * (`hh wire … --yes | head -1` still wires). Any other error of these
 * streams is thrown, as Node would without a listener. Adds one listener
 * per stream however often it is called.
 *
 * @param streams Standard output and error by default.
 */
export function outliveClosedPipes(
  streams: readonly ErrorEmitter[] = [process.stdout, process.stderr],
): void {
  for (const stream of streams) {
    if (watched.has(stream)) continue;
    watched.add(stream);
    stream.on("error", (error) => {
      if (!readerGone(error)) throw error;
    });
  }
}

/**
 * Waits until `stream`, whose last write returned false, takes more.
 *
 * @returns True on `drain`, false when the reader has gone (EPIPE): the
 *   writer should stop.
 * @throws The stream's other errors.
 */
export function drained(stream: DrainEmitter): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      stream.off("error", onError);
      resolve(true);
    };
    const onError = (error: Error) => {
      stream.off("drain", onDrain);
      if (readerGone(error)) resolve(false);
      else reject(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}
