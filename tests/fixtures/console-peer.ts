import { createServer } from "node:http";

// Stand-in for the bundled Next console: listens on PORT/HOSTNAME, proxies /api/gateway/*
// to HARNESSHUB_GATEWAY_URL like the real route, and reports what it was started with.
if (process.env.FIXTURE_CONSOLE_EXIT) {
  process.stderr.write("fixture console failed on purpose\n");
  process.exit(Number(process.env.FIXTURE_CONSOLE_EXIT));
}
const upstream = process.env.HARNESSHUB_GATEWAY_URL;
const server = createServer((request, response) => {
  void (async () => {
    if (request.url === "/fixture") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          pid: process.pid,
          port: process.env.PORT,
          hostname: process.env.HOSTNAME,
          gateway: upstream,
          telemetry: process.env.NEXT_TELEMETRY_DISABLED,
          names: Object.keys(process.env).sort(),
        }),
      );
      return;
    }
    if (request.url?.startsWith("/api/gateway/") && upstream) {
      const reply = await fetch(
        new URL(request.url.slice("/api/gateway".length), upstream),
      );
      response.writeHead(reply.status, {
        "content-type": reply.headers.get("content-type") ?? "text/plain",
      });
      response.end(Buffer.from(await reply.arrayBuffer()));
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>HarnessHub</title>");
  })().catch(() => {
    response.writeHead(502);
    response.end();
  });
});
server.listen(Number(process.env.PORT), process.env.HOSTNAME, () => {
  process.stdout.write(`fixture console listening on ${process.env.PORT}\n`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
