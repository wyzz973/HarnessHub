#!/usr/bin/env node
// The `lib/bin.js` of a stand-in `@deepseek-ai/dsh` package a test lays out: `--profile acp` plays a recorded ACP conversation (tests/fixtures/dsh/replay-peer.mjs),
// any other profile the recorded Web host (replay-host.mjs), or exits at once when $DSH_REPLAY_WEB_EXIT says so (a Web host that does not start).
const args = process.argv.slice(2);
if (args.includes("acp")) {
  process.argv = [process.argv[0], process.argv[1], process.env.DSH_REPLAY_ACP_FIXTURE, process.env.DSH_REPLAY_ACP_INDEX ?? "0"];
  await import(process.env.DSH_REPLAY_ACP_PEER);
} else if (process.env.DSH_REPLAY_WEB_EXIT) process.exit(Number(process.env.DSH_REPLAY_WEB_EXIT));
else await import(process.env.DSH_REPLAY_WEB_HOST);
