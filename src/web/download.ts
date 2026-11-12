import type { ServerResponse } from "node:http";

/** The longest a download holds the event loop before it gives it back to other requests; the pieces are cut where a Turn ends, so this is checked between them. */
const SLICE_MS = 20;

/** Resolves when the response can take more, or is gone. */
function writable(response: ServerResponse): Promise<void> {
  return new Promise(resolve => {
    const done = (): void => { response.off("drain", done); response.off("close", done); resolve(); };
    response.once("drain", done); response.once("close", done);
  });
}

/**
 * Sends a body made of pieces, one after the other, so that nothing but the piece being written is held (an export of a conversation is as long as the conversation). The first piece is made
 * before anything is sent: a failure to make it is the caller's, to answer as any other (`begin` then sets the status and the headers). After that the socket sets the pace — the next piece is
 * made when the last one has gone out — and the loop is given back between pieces now and then. A client that went away stops the reading at once. A piece that cannot be made once the
 * status is sent ends the connection (the client gets a download that broke, never a file that looks whole): the failure is not thrown, there is nothing left to answer it with.
 * Resolves when the body was sent, the client left, or the connection was ended.
 */
export async function sendPieces(response: ServerResponse, pieces: Iterator<string>, begin: () => void): Promise<void> {
  let step = pieces.next();
  begin();
  let slice = Date.now();
  try {
    while (!step.done) {
      if (response.destroyed) { pieces.return?.(); return; }
      if (!response.write(step.value)) await writable(response);
      else if (Date.now() - slice > SLICE_MS) { await new Promise<void>(resolve => setImmediate(resolve)); slice = Date.now(); }
      if (response.destroyed) { pieces.return?.(); return; }
      step = pieces.next();
    }
    response.end();
  } catch {
    response.destroy();
  }
}
