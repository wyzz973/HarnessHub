import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Pi 0.85.1 native extension; MCP SDK comes from the fixed engine installation. */
export default async function nativeMcp(pi) {
  const clients = [];
  let closing;
  const close = () =>
    (closing ??= (async () => {
      const results = await Promise.allSettled(
        clients.map(async ({ client, transport }) => {
          const pid = transport.pid;
          await client.close();
          // SDK 1.30 awaits graceful shutdown, but its final kill is not awaited.
          // Verify the direct child's exit; Worker Job ownership reaps descendants.
          if (pid) {
            const deadline = Date.now() + 2000;
            for (;;) {
              try {
                process.kill(pid, 0);
              } catch (error) {
                if (error.code === "ESRCH") break;
                throw error;
              }
              if (Date.now() >= deadline)
                throw new Error("MCP child did not exit");
              await delay(10);
            }
          }
        }),
      );
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Native MCP cleanup failed");
    })());
  pi.on("session_shutdown", close);
  try {
    const config = JSON.parse(
      await readFile(process.env.HARNESSHUB_NATIVE_MCP_CONFIG, "utf8"),
    );
    const [
      { Client },
      { StdioClientTransport },
      { StreamableHTTPClientTransport },
      { SSEClientTransport },
    ] = await Promise.all([
      import(config.sdk.index),
      import(config.sdk.stdio),
      import(config.sdk.streamableHttp),
      import(config.sdk.sse),
    ]);
    const names = new Set();
    for (const server of config.servers) {
      const resolve = (fields) =>
        Object.fromEntries(
          Object.entries(fields).map(([name, alias]) => {
            const value = process.env[alias];
            if (value === undefined)
              throw new Error("Native MCP environment reference is missing");
            return [name, value];
          }),
        );
      const transport = server.command
        ? new StdioClientTransport({
            command: server.command,
            args: server.args,
            env: resolve(server.env),
            cwd: config.cwd,
            stderr: "pipe",
          })
        : server.type === "http"
          ? new StreamableHTTPClientTransport(new URL(server.url), {
              requestInit: { headers: resolve(server.headers) },
            })
          : new SSEClientTransport(new URL(server.url), {
              requestInit: { headers: resolve(server.headers) },
            });
      // Never publish arbitrary MCP stderr, which may contain credentials.
      transport.stderr?.resume();
      const client = new Client(
        { name: "HarnessHub-Pi-MCP", version: "1.0.0" },
        { capabilities: {} },
      );
      client.onerror = () => {};
      clients.push({ client, transport });
      await client.connect(transport, { timeout: 10000 });
      const cursors = new Set();
      let cursor;
      do {
        const result = await client.listTools(cursor ? { cursor } : {}, {
          timeout: 10000,
        });
        for (const tool of result.tools) {
          const name = `mcp__${server.name}__${tool.name}`;
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || names.has(name))
            throw new Error("MCP tool name is unsupported or duplicated");
          names.add(name);
          pi.registerTool({
            name,
            label: name,
            description: tool.description ?? `MCP tool ${tool.name}`,
            parameters: tool.inputSchema,
            async execute(_id, args, signal) {
              const output = await client.callTool(
                { name: tool.name, arguments: args },
                undefined,
                { signal },
              );
              if (output.isError) throw new Error("MCP tool reported an error");
              const content = output.content ?? [];
              if (
                content.some(
                  (item) => item.type !== "text" && item.type !== "image",
                )
              )
                throw new Error(
                  "Pi native MCP supports text and image tool results only",
                );
              return {
                content,
                details: {
                  server: server.name,
                  tool: tool.name,
                  ...(output.structuredContent
                    ? { structuredContent: output.structuredContent }
                    : {}),
                },
              };
            },
          });
        }
        cursor = result.nextCursor;
        if (cursor && cursors.has(cursor))
          throw new Error("MCP tools pagination repeated a cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
    }
  } catch {
    // Pi normally logs extension-load errors and continues without that extension.
    // A selected MCP server is required: stop the native engine after cleanup so
    // a formal Worker cannot publish success with silently missing tools.
    try {
      await close();
    } catch {
      /* Worker process ownership confirms final cleanup. */
    }
    process.stderr.write("HarnessHub: native MCP initialization failed.\n");
    process.exit(1);
  }
}
