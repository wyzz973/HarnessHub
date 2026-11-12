// Makes (or checks) wire-golden.json: what the application of a build says over HTTP of every v13 fixture (wire.ts).
//
//   node tests/fixtures/storage/v13/generate-wire.mjs <dist directory of a build that has wire.js> <output.json>
//
// wire-golden.json was made by the build before the cut (the store of snapshots, `SqliteSessionStore`, at 26d4907), with this file and wire.ts added to it; it is not to be
// made again by a build after the cut, whose answers it is held against (tests/integration/cut-wire.test.ts).
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [dist, out] = process.argv.slice(2);
if (!dist || !out) { process.stderr.write("usage: generate-wire.mjs <dist directory> <output.json>\n"); process.exit(2); }
const { wireOfAll } = await import(pathToFileURL(resolve(dist, "tests/fixtures/storage/v13/wire.js")).href);
writeFileSync(out, JSON.stringify(await wireOfAll(), null, 1) + "\n");
