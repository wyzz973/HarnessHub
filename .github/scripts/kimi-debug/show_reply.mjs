// Debug-only: print the non-ASCII acceptance step of every acceptance-<engine>.json in DIR.
// The reply comes from GET /session/{id}/message; it is printed with \u escapes so the log
// shows the exact code points whatever the console encoding is.
// Usage: node show_reply.mjs DIR [--require ENGINE]
//   Exit 1 when --require is given and that engine did not PASS overall, or any engine's
//   unicode-reply step is not PASS.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const directory = process.argv[2];
const required = process.argv[3] === "--require" ? process.argv[4] : undefined;
const ascii = (text) =>
  JSON.stringify(text ?? null).replace(
    /[\u0080-￿]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
let failed = false;
for (const name of readdirSync(directory).filter((file) => /^acceptance-.*\.json$/.test(file))) {
  const result = JSON.parse(readFileSync(path.join(directory, name), "utf8"));
  const step = result.steps.find((candidate) => candidate.id === "unicode-reply");
  console.log(
    `${result.engine}: ${result.status}; unicode-reply ${step?.status ?? "missing"} http=${step?.detail?.httpStatus ?? "-"} finish=${step?.detail?.finish ?? "-"} reply=${ascii(step?.detail?.reply)}${step?.error ? ` error=${ascii(step.error.slice(0, 300))}` : ""}`,
  );
  if (required && step?.status !== "PASS") failed = true;
  if (required === result.engine && result.status !== "PASS") failed = true;
}
process.exit(failed ? 1 : 0);
