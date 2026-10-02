import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";

// Deliberately dependency-free. The same bounded operations serve MCP and the local CLI.
const limits = {
  message: 65536,
  buffered: 131072,
  response: 262144,
  file: 1048576,
  entries: 500,
  visited: 2000,
  searchBytes: 8388608,
  text: 16384,
  milliseconds: 5000,
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message) => {
  throw new Error(message);
};
const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const relativeSchema = {
  type: "string",
  maxLength: 1024,
  description:
    "Workspace-relative path with forward slashes; use . for its root.",
};
const tools = [
  {
    name: "workspace_list",
    description:
      "List one local directory, at most 500 entries. Links are marked blocked and never followed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { path: relativeSchema },
      required: ["path"],
    },
    annotations,
  },
  {
    name: "workspace_read",
    description:
      "Read UTF-8 text from one regular file of at most 1 MiB, with line numbers and explicit truncation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: relativeSchema,
        startLine: { type: "integer", minimum: 1, maximum: 1000000 },
        maxLines: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["path"],
    },
    annotations,
  },
  {
    name: "workspace_search",
    description:
      "Search literal text in local UTF-8 files; no regex. Traversal, bytes, matches and time are bounded; .git, node_modules and .tools directories are skipped.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: relativeSchema,
        query: { type: "string", minLength: 1, maxLength: 256 },
        maxResults: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["path", "query"],
    },
    annotations,
  },
];
let stopped = false;
const interrupt = () => {
  stopped = true;
  process.stdin.destroy();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
process.stdout.on("error", interrupt);

function relative(value) {
  if (typeof value !== "string" || !value.length || value.length > 1024)
    fail("Expected a bounded workspace-relative path");
  if (value === ".") return "";
  const parts = value.split("/");
  if (
    parts.length > 32 ||
    /[\\:\u0000-\u001f<>"|?*]/.test(value) ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
    )
  )
    fail("Path traversal, absolute paths and Windows aliases are not allowed");
  return parts.join("/");
}
function same(a, b) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.nlink === b.nlink
  );
}
async function chain(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  const names = [current];
  for (const segment of absolute
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    names.push(current);
  }
  const result = [];
  for (const name of names) {
    const info = await lstat(name, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink())
      fail("Directory links are not allowed");
    result.push({ name, dev: info.dev, ino: info.ino });
  }
  return result;
}
async function unchangedChain(entries) {
  for (const entry of entries) {
    const info = await lstat(entry.name, { bigint: true });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.dev !== entry.dev ||
      info.ino !== entry.ino
    )
      fail("Directory changed during access");
  }
}
function argumentsFor(name, input) {
  const schema = tools.find((tool) => tool.name === name)?.inputSchema;
  if (!schema) fail("Unknown tool");
  if (
    !object(input) ||
    Object.keys(input).some((key) => !Object.hasOwn(schema.properties, key))
  )
    fail("Unknown or invalid tool arguments");
  relative(input.path);
  for (const [key, rule] of Object.entries(schema.properties)) {
    const value = input[key];
    if (value === undefined) {
      if (schema.required.includes(key)) fail(`Missing ${key}`);
      continue;
    }
    if (
      rule.type === "integer" &&
      (!Number.isSafeInteger(value) ||
        value < rule.minimum ||
        value > rule.maximum)
    )
      fail(`Invalid ${key}`);
    if (
      rule.type === "string" &&
      (typeof value !== "string" ||
        value.length > rule.maxLength ||
        (rule.minLength && value.length < rule.minLength))
    )
      fail(`Invalid ${key}`);
  }
  return input;
}
async function service(root) {
  if (!path.isAbsolute(root))
    fail("--root requires an absolute local workspace directory");
  const rootChain = await chain(root);
  const workspace = await realpath(root);
  if (path.relative(workspace, path.resolve(root)))
    fail("Workspace links are not allowed");
  async function checked(relativePath, deadline) {
    if (stopped || Date.now() > deadline)
      fail("Operation cancelled or time limit reached");
    await unchangedChain(rootChain);
    const name = relative(relativePath);
    const target = path.join(workspace, ...name.split("/"));
    const ancestors = await chain(path.dirname(target));
    const info = await lstat(target, { bigint: true });
    if (
      info.isSymbolicLink() ||
      (!info.isDirectory() && !info.isFile()) ||
      (info.isFile() && info.nlink !== 1n)
    )
      fail("Links and non-regular files are not allowed");
    const physical = await realpath(target);
    const inside = path.relative(workspace, physical);
    if (
      inside === ".." ||
      inside.startsWith(`..${path.sep}`) ||
      path.isAbsolute(inside) ||
      path.relative(target, physical)
    )
      fail("Path escapes workspace or follows a link");
    return { target, info, ancestors };
  }
  async function textFile(name, deadline) {
    const original = await checked(name, deadline);
    if (!original.info.isFile() || original.info.size > BigInt(limits.file))
      fail("Expected a regular text file no larger than 1 MiB");
    const file = await open(
      original.target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await file.stat({ bigint: true });
      if (!same(original.info, opened)) fail("File changed before reading");
      const bytes = Buffer.alloc(Number(opened.size) + 1);
      let length = 0;
      while (length < bytes.length) {
        if (stopped || Date.now() > deadline)
          fail("Operation cancelled or time limit reached");
        const read = await file.read(
          bytes,
          length,
          Math.min(65536, bytes.length - length),
          null,
        );
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (
        length !== Number(opened.size) ||
        !same(opened, await file.stat({ bigint: true })) ||
        !same(opened, (await checked(name, deadline)).info)
      )
        fail("File changed while reading");
      await unchangedChain(original.ancestors);
      const content = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, length),
      );
      if (content.includes("\0")) fail("Binary files are not supported");
      return { content, bytes: length };
    } finally {
      await file.close();
    }
  }
  async function directory(name, deadline, maximum) {
    const original = await checked(name, deadline);
    if (!original.info.isDirectory()) fail("Expected a directory");
    const entries = [];
    let truncated = false;
    const stream = await opendir(original.target);
    try {
      for (;;) {
        if (stopped || Date.now() > deadline)
          fail("Operation cancelled or time limit reached");
        const item = await stream.read();
        if (!item) break;
        if (entries.length === maximum) {
          truncated = true;
          break;
        }
        entries.push({
          name: item.name,
          type: item.isSymbolicLink()
            ? "blocked"
            : item.isDirectory()
              ? "directory"
              : item.isFile()
                ? "file"
                : "blocked",
        });
      }
    } finally {
      await stream.close();
    }
    await unchangedChain(original.ancestors);
    const after = await checked(name, deadline);
    if (!same(original.info, after.info))
      fail("Directory changed while listing");
    return {
      entries: entries.sort((a, b) => a.name.localeCompare(b.name, "en")),
      truncated,
    };
  }
  return async (name, input) => {
    const args = argumentsFor(name, input);
    const deadline = Date.now() + limits.milliseconds;
    if (name === "workspace_list")
      return directory(args.path, deadline, limits.entries);
    if (name === "workspace_read") {
      const read = await textFile(args.path, deadline);
      const all = read.content.split(/\r?\n/);
      const start = (args.startLine ?? 1) - 1;
      const selected = all.slice(start, start + (args.maxLines ?? 100));
      const text = selected.join("\n").slice(0, limits.text);
      return {
        path: args.path,
        startLine: start + 1,
        text,
        truncated:
          start + selected.length < all.length ||
          text.length < selected.join("\n").length,
      };
    }
    const matches = [];
    const queue = [args.path];
    let visited = 0,
      bytes = 0,
      skipped = 0,
      truncated = false;
    while (queue.length && !truncated) {
      if (++visited > limits.visited) {
        truncated = true;
        break;
      }
      const current = queue.shift();
      try {
        const item = await checked(current, deadline);
        if (item.info.isDirectory()) {
          const listing = await directory(current, deadline, limits.entries);
          if (listing.truncated) truncated = true;
          for (const entry of listing.entries) {
            if (
              entry.type === "blocked" ||
              (entry.type === "directory" &&
                [".git", "node_modules", ".tools"].includes(entry.name))
            ) {
              skipped++;
              continue;
            }
            if (queue.length + visited >= limits.visited) {
              truncated = true;
              break;
            }
            queue.push(
              current === "." ? entry.name : `${current}/${entry.name}`,
            );
          }
        } else {
          if (item.info.size > BigInt(limits.file)) {
            skipped++;
            continue;
          }
          if (bytes + Number(item.info.size) > limits.searchBytes) {
            truncated = true;
            break;
          }
          const read = await textFile(current, deadline);
          bytes += read.bytes;
          const lines = read.content.split(/\r?\n/);
          for (let index = 0; index < lines.length; index++)
            if (lines[index].includes(args.query)) {
              if (matches.length === (args.maxResults ?? 50)) {
                truncated = true;
                break;
              }
              matches.push({
                path: current,
                line: index + 1,
                text: lines[index].slice(0, 256),
              });
            }
        }
      } catch (error) {
        if (current === args.path || stopped || Date.now() > deadline)
          throw error;
        skipped++;
      }
    }
    return { matches, visited, bytes, skipped, truncated };
  };
}
async function output(value) {
  const text = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(text) > limits.response)
    fail("Response size limit reached");
  await new Promise((resolve, reject) =>
    process.stdout.write(text, (error) => (error ? reject(error) : resolve())),
  );
}
async function serve(call) {
  let initialized = false,
    ready = false;
  let pending = Buffer.alloc(0);
  async function message(bytes) {
    let request;
    try {
      request = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      return output({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Invalid UTF-8 JSON" },
      });
    }
    if (
      !object(request) ||
      request.jsonrpc !== "2.0" ||
      typeof request.method !== "string" ||
      (Object.hasOwn(request, "id") &&
        !(typeof request.id === "string" || Number.isSafeInteger(request.id)))
    )
      return output({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid JSON-RPC request" },
      });
    if (!Object.hasOwn(request, "id")) {
      if (request.method === "notifications/initialized" && initialized)
        ready = true;
      return;
    }
    const answer = (result) =>
      output({ jsonrpc: "2.0", id: request.id, result });
    const error = (code, text) =>
      output({
        jsonrpc: "2.0",
        id: request.id,
        error: { code, message: text },
      });
    if (request.method === "ping") return answer({});
    if (request.method === "initialize") {
      if (
        initialized ||
        !object(request.params) ||
        typeof request.params.protocolVersion !== "string" ||
        !object(request.params.capabilities) ||
        !object(request.params.clientInfo)
      )
        return error(
          -32602,
          "Invalid initialize parameters or repeated initialization",
        );
      initialized = true;
      return answer({
        protocolVersion: versions.includes(request.params.protocolVersion)
          ? request.params.protocolVersion
          : versions[0],
        capabilities: { tools: {} },
        serverInfo: { name: "harnesshub-workspace-tools", version: "1.0.0" },
      });
    }
    if (!ready)
      return error(
        -32000,
        "Initialize and send notifications/initialized before using tools",
      );
    if (request.method === "tools/list") {
      if (request.params?.cursor)
        return error(-32602, "This server has no tool-list pagination cursor");
      return answer({ tools });
    }
    if (request.method !== "tools/call")
      return error(-32601, "Method not found");
    if (
      !object(request.params) ||
      !tools.some((tool) => tool.name === request.params.name)
    )
      return error(-32602, "Unknown tool name");
    try {
      const result = await call(
        request.params.name,
        request.params.arguments ?? {},
      );
      return answer({
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: false,
      });
    } catch (failure) {
      return answer({
        content: [
          {
            type: "text",
            text: failure.code
              ? "Local filesystem access failed"
              : failure.message,
          },
        ],
        isError: true,
      });
    }
  }
  for await (const chunk of process.stdin) {
    if (stopped) break;
    if (pending.length + chunk.length > limits.buffered)
      fail("Input buffer limit exceeded");
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const newline = pending.indexOf(10);
      if (newline < 0) {
        if (pending.length > limits.message)
          fail("Message size limit exceeded");
        break;
      }
      if (newline > limits.message) fail("Message size limit exceeded");
      const bytes = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      await message(bytes);
    }
  }
  if (pending.length && !stopped) fail("Incomplete JSON-RPC line");
}
try {
  const [flag, root, operation, json, ...extra] = process.argv.slice(2);
  if (
    flag !== "--root" ||
    !root ||
    extra.length ||
    (operation && (!json || !["list", "read", "search"].includes(operation)))
  )
    fail(
      "Usage: node workspace-tools.mjs --root ABSOLUTE_WORKSPACE [list|read|search JSON]",
    );
  const call = await service(root);
  if (operation)
    await output(await call(`workspace_${operation}`, JSON.parse(json)));
  else await serve(call);
} catch (error) {
  if (!stopped) {
    process.stderr.write(
      error.code
        ? "Workspace tool could not access local files\n"
        : `${error.message}\n`,
    );
    process.exitCode = 1;
  }
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
