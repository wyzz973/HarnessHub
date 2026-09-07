import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startHub } from "../../src/main.js";
import type {
  PermissionRecord,
  RunRecord,
  SessionRecord,
} from "../../src/domain/types.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const prepared = path.join(repository, ".tools/contest-prepared/win32-arm64");
const modules = path.join(prepared, "engines/npm/node_modules");
const enabled = process.env.HARNESSHUB_TEST_NATIVE_MCP === "1";

interface Receipt {
  method?: string;
  pid?: number;
  childPid?: number;
  keyMatches?: boolean;
  arguments?: unknown;
}
interface Completion {
  tools?: { function?: { name?: string; description?: string } }[];
  messages?: unknown[];
}
interface ObservedRun extends RunRecord {
  permissions?: PermissionRecord[];
}

async function scan(directory: string, value: string): Promise<string[]> {
  const matches: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...(await scan(file, value)));
    else if (
      entry.isFile() &&
      (await readFile(file)).includes(Buffer.from(value))
    )
      matches.push(file);
  }
  return matches;
}

for (const [adapter, mode] of [
  ["pi", "completed"],
  ["openclaw", "completed"],
  ["kimi", "completed"],
  ["codex", "completed"],
  ["gemini", "completed"],
  ["qwen", "completed"],
  ["mimo", "completed"],
  ["dsh", "completed"],
  ["opencode", "completed"],
  ["hermes", "completed"],
  ["pi", "failed"],
  ["pi", "cancelled"],
] as const) {
  void test(
    `fixed ${adapter} native MCP ${mode} through Gateway/Worker cleans its process tree`,
    {
      timeout: 100_000,
      skip: !enabled
        ? "Set HARNESSHUB_TEST_NATIVE_MCP=1 with the fixed prepared Windows ARM64 engines"
        : false,
    },
    async (t) => {
      assert.equal(process.platform, "win32");
      assert.ok(
        existsSync(path.join(prepared, "prepared.json")),
        "Prepare the fixed engine payload before native verification",
      );
      const directory = await mkdtemp(
        path.join(tmpdir(), `harnesshub-native-mcp-${adapter}-中文 `),
      );
      let successful = false;
      let closeHub: (() => Promise<void>) | undefined;
      let closeServer: (() => Promise<void>) | undefined;
      t.after(async () => {
        await closeHub?.();
        await closeServer?.();
        if (successful) await rm(directory, { recursive: true });
        else t.diagnostic(`Native fixture evidence retained at ${directory}`);
      });
      const workspace = path.join(directory, "workspace");
      await mkdir(workspace);
      const skillDirectory = path.join(workspace, "fixture-skill");
      await mkdir(path.join(skillDirectory, "references"), { recursive: true });
      const skill = path.join(skillDirectory, "SKILL.md");
      const skillText =
        "---\nname: fixture-skill\ndescription: Verify configured Skill delivery.\n---\nSKILL_CONTEXT_CONFIRMED\nThe attachment is references/context.txt relative to this Skill's base_directory.\n";
      await writeFile(skill, skillText);
      await writeFile(
        path.join(skillDirectory, "references/context.txt"),
        "SKILL_ATTACHMENT_CONFIRMED\n",
      );
      const modelKey = "synthetic-model-only-key";
      const mcpKey = "synthetic-mcp-only-key";
      const keyFile = path.join(directory, "model-key.txt");
      const mcpKeyFile = path.join(directory, "mcp-key.txt");
      await writeFile(keyFile, modelKey);
      await writeFile(mcpKeyFile, mcpKey);
      const receipts: Receipt[] = [];
      const requests: {
        tools: string[];
        hasToolResult: boolean;
        hasSkill: boolean;
      }[] = [];
      let requestFailure: unknown;
      const server = createServer((req, res) => {
        void (async () => {
          let bytes = "";
          for await (const chunk of req) bytes += String(chunk);
          if (req.url === "/receipt") {
            receipts.push(JSON.parse(bytes) as Receipt);
            res.end("ok");
            return;
          }
          if (
            !req.url?.endsWith("/chat/completions") ||
            req.method !== "POST"
          ) {
            res.writeHead(404);
            res.end();
            return;
          }
          assert.equal(req.headers.authorization, `Bearer ${modelKey}`);
          const body = JSON.parse(bytes) as Completion;
          const tools = (body.tools ?? []).map(
            (tool) => tool.function?.name ?? "",
          );
          const name =
            tools.find((name) => name.endsWith("workspace_echo")) ??
            body.tools?.find((tool) =>
              tool.function?.description?.includes(
                "Return the supplied text through this MCP server.",
              ),
            )?.function?.name;
          const hasToolResult = JSON.stringify(body.messages).includes(
            "MCP_TOOL_CONFIRMED",
          );
          const alreadyAttempted = (body.messages ?? []).some(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              "role" in message &&
              message.role === "assistant" &&
              "tool_calls" in message,
          );
          const hasSkill =
            JSON.stringify(body.messages).includes("SKILL_CONTEXT_CONFIRMED") &&
            JSON.stringify(body.messages).includes("base_directory");
          requests.push({ tools, hasToolResult, hasSkill });
          res.writeHead(200, { "content-type": "text/event-stream" });
          const chunk = (delta: unknown, reason: string | null) =>
            res.write(
              `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
            );
          if (name && !hasToolResult && !alreadyAttempted) {
            chunk(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_fixture",
                    type: "function",
                    function: {
                      name,
                      arguments: JSON.stringify({
                        message: "literal 中文 & $()",
                      }),
                    },
                  },
                ],
              },
              null,
            );
            chunk({}, "tool_calls");
          } else {
            chunk(
              {
                role: "assistant",
                content: hasToolResult
                  ? "NATIVE_MCP_VERIFIED"
                  : "NATIVE_MCP_MISSING",
              },
              null,
            );
            chunk({}, "stop");
          }
          res.end("data: [DONE]\n\n");
        })().catch((error: unknown) => {
          requestFailure = error;
          res.writeHead(500);
          res.end();
        });
      });
      server.on("connect", (_request, socket) => {
        // Bun may reset this rejected proxy connection without reading the 403.
        // Only these explicitly refused CONNECT sockets own this expected error;
        // model requests, MCP requests, and other socket failures remain failures.
        socket.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== "ECONNRESET") requestFailure = error;
        });
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      });
      closeServer = async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      };
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const url = `http://127.0.0.1:${address.port}`;
      const peer = path.join(directory, "mcp-peer.mjs");
      await writeFile(
        peer,
        `import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
const receipt=${JSON.stringify(url + "/receipt")};
const mode=${JSON.stringify(mode)};
const post=async(value)=>{const response=await fetch(receipt,{method:'POST',body:JSON.stringify(value)});if(!response.ok)throw Error('receipt failed')};
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
await post({pid:process.pid,childPid:child.pid,keyMatches:process.env.FIXTURE_VALUE===${JSON.stringify(adapter === "kimi" ? "ordinary" : mcpKey)}});
const input=createInterface({input:process.stdin});
for await(const line of input){const request=JSON.parse(line);await post({method:request.method,arguments:request.params?.arguments});if(request.id===undefined)continue;let result;
if(mode==='failed'&&request.method==='initialize'){process.stderr.write(process.env.FIXTURE_VALUE);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:'fixture initialization failure'}})+'\\n');continue;}
if(mode==='cancelled'&&request.method==='tools/call')continue;
if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
else if(request.method==='tools/list')result={tools:[{name:'workspace_echo',description:'Return the supplied text through this MCP server.',inputSchema:{type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false}}]};
else if(request.method==='tools/call')result={content:[{type:'text',text:'MCP_TOOL_CONFIRMED '+request.params.arguments.message}]};
else if(request.method==='resources/list')result={resources:[]};
else if(request.method==='prompts/list')result={prompts:[]};
else result={};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');}
process.exit(0);
`,
      );
      const entries = {
        codex: [
          process.execPath,
          path.join(modules, "@agentclientprotocol/codex-acp/dist/index.js"),
        ],
        gemini: [
          process.execPath,
          path.join(modules, "@google/gemini-cli/bundle/gemini.js"),
          "--acp",
        ],
        pi: [process.execPath, path.join(modules, "pi-acp/dist/index.js")],
        openclaw: [
          process.execPath,
          path.join(repository, "scripts/launch-openclaw-bundled.mjs"),
          path.join(modules, "openclaw/openclaw.mjs"),
        ],
        kimi: [
          path.join(prepared, "engines/kimi/kimi.exe"),
          "--quiet",
          "--prompt",
          "{prompt}",
        ],
        qwen: [
          process.execPath,
          path.join(modules, "@qwen-code/qwen-code/cli-entry.js"),
          "--acp",
          "--experimental-skills",
        ],
        mimo: [
          path.join(modules, "@mimo-ai/mimocode-windows-arm64/bin/mimo.exe"),
          "acp",
        ],
        dsh: [
          process.execPath,
          path.join(modules, "@deepseek-ai/dsh/lib/bin.js"),
          "--profile",
          "acp",
        ],
        opencode: [path.join(prepared, "engines/opencode/opencode.exe"), "acp"],
        hermes: [
          path.join(prepared, "engines/hermes/runtime/python.exe"),
          "-I",
          "-B",
          "-m",
          "acp_adapter",
        ],
      };
      const entry = entries[adapter];
      const environment = {
        HOME: directory,
        USERPROFILE: directory,
        APPDATA: path.join(directory, "Roaming"),
        LOCALAPPDATA: path.join(directory, "Local"),
        PATH: [
          path.join(prepared, "runtime"),
          path.join(prepared, "bin"),
          path.join(prepared, "bin/git/cmd"),
          path.join(prepared, "bin/git/usr/bin"),
          path.join(process.env.SystemRoot!, "System32"),
        ].join(";"),
        HTTP_PROXY: url,
        HTTPS_PROXY: url,
        NO_PROXY: "127.0.0.1,localhost",
        PI_ACP_PI_COMMAND: path.join(prepared, "bin/pi.cmd"),
        PI_SKIP_VERSION_CHECK: "1",
        OPENCLAW_NO_BANNER: "1",
        HERMES_DISABLE_LAZY_INSTALLS: "1",
        HERMES_GIT_BASH_PATH: path.join(prepared, "bin/git/usr/bin/bash.exe"),
        QWEN_DISABLE_AUTO_UPDATE: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        MIMOCODE_DISABLE_AUTOUPDATE: "true",
        CODEX_EXECUTABLE: path.join(
          modules,
          "@openai/codex-win32-arm64/vendor/aarch64-pc-windows-msvc/bin/codex.exe",
        ),
      };
      const config = path.join(directory, "engines.json");
      await writeFile(
        config,
        JSON.stringify({
          engines: [
            {
              id: adapter,
              driver: adapter === "kimi" ? "cli" : "acp",
              model: "fixture",
              command: [
                process.execPath,
                path.join(repository, "scripts/launch-engine.mjs"),
                ...Object.entries(environment).map(
                  ([name, value]) => `${name}=${value}`,
                ),
                "--",
                ...entry,
              ],
              ...(adapter === "kimi"
                ? { cli: { inputMode: "argv", maxOutputBytes: 1048576 } }
                : { acp: { initializeTimeoutMs: 60000 } }),
              configuration: {
                adapter,
                skills: [
                  {
                    path: skill,
                    enabled: true,
                    sha256: createHash("sha256")
                      .update(skillText)
                      .digest("hex"),
                  },
                ],
                ...(adapter === "kimi"
                  ? { env: { KIMI_MODEL_MAX_CONTEXT_SIZE: "131072" } }
                  : {}),
                provider: {
                  protocol: "openai-completions",
                  baseUrl: `${url}/v1`,
                  apiKey: { kind: "file", value: keyFile },
                },
                mcpServers: [
                  {
                    name: "fixture",
                    type: "stdio",
                    enabled: true,
                    command: process.execPath,
                    args: [peer],
                    ...(adapter === "kimi"
                      ? { env: { FIXTURE_VALUE: "ordinary" } }
                      : {
                          secretEnv: {
                            FIXTURE_VALUE: { kind: "file", value: mcpKeyFile },
                          },
                        }),
                  },
                ],
              },
            },
          ],
          cancelGraceMs: 2000,
        }),
      );
      const dataDir = path.join(directory, "data");
      const hub = await startHub({
        configFile: config,
        dataDir,
        cwd: workspace,
        demo: false,
        port: 0,
      });
      closeHub = () => hub.server.close();
      const created = await hub.server.inject({
        method: "POST",
        url: "/v1/sessions",
        payload: { engineId: adapter },
      });
      assert.equal(created.statusCode, 201, created.body);
      const session = created.json<SessionRecord>();
      const accepted = await hub.server.inject({
        method: "POST",
        url: `/v1/sessions/${session.id}/runs`,
        payload: {
          text: "Call the workspace_echo MCP tool with the supplied fixture text, then return the verification marker.",
          timeoutMs: 60000,
        },
      });
      assert.equal(accepted.statusCode, 202, accepted.body);
      let run = accepted.json<ObservedRun>();
      let cancelSent = false;
      const approved = new Set<string>();
      const until = Date.now() + 65000;
      while (!run.finishedAt) {
        assert.ok(
          Date.now() < until,
          "Formal Run did not settle within its deadline",
        );
        for (const permission of run.permissions ?? []) {
          if (permission.status !== "pending" || approved.has(permission.id))
            continue;
          assert.ok(
            permission.toolCallId === "call_fixture" ||
              /workspace_echo/.test(permission.prompt),
            "Only the fixture MCP call may be approved",
          );
          const option = permission.options.find(
            (option) => option.kind === "allow_once",
          );
          assert.ok(
            option,
            "Native approval must expose a one-time allow option",
          );
          const decision = await hub.server.inject({
            method: "POST",
            url: `/v1/permissions/${permission.id}/decision`,
            payload: { optionId: option.id },
          });
          assert.equal(decision.statusCode, 200, decision.body);
          approved.add(permission.id);
        }
        if (
          mode === "cancelled" &&
          !cancelSent &&
          receipts.some((receipt) => receipt.method === "tools/call")
        ) {
          const canceled = await hub.server.inject({
            method: "POST",
            url: `/v1/runs/${run.id}/cancel`,
          });
          assert.equal(canceled.statusCode, 202, canceled.body);
          cancelSent = true;
        }
        await delay(40);
        run = (
          await hub.server.inject({ method: "GET", url: `/v1/runs/${run.id}` })
        ).json<ObservedRun>();
      }
      const events = hub.app.events(run.id, 0, 1000);
      while (events.length && events.at(-1)!.seq < run.lastSeq) {
        const page = hub.app.events(run.id, events.at(-1)!.seq, 1000);
        assert.ok(
          page.length > 0,
          "Committed events must remain readable through the final sequence",
        );
        events.push(...page);
      }
      await writeFile(
        path.join(directory, "evidence.json"),
        JSON.stringify({ run, requests, receipts, events }, null, 2),
      );
      assert.equal(requestFailure, undefined);
      assert.equal(run.status, mode, JSON.stringify(run));
      if (mode !== "failed")
        assert.ok(
          requests.some((request) => request.hasSkill),
          "The pinned Skill and attachment base directory must reach the real engine's Chat API",
        );
      if (mode === "completed")
        assert.ok(
          requests.some((request) => request.hasToolResult),
          "The real engine must send the MCP result back to its model",
        );
      if (mode === "failed")
        assert.equal(
          requests.length,
          0,
          "Missing required MCP must stop Pi before model requests",
        );
      else
        assert.ok(
          receipts.some(
            (receipt) =>
              receipt.method === "tools/call" &&
              JSON.stringify(receipt.arguments) ===
                JSON.stringify({ message: "literal 中文 & $()" }),
          ),
          "The native MCP server must receive tools/call",
        );
      if (mode === "cancelled") assert.ok(cancelSent);
      assert.ok(
        !JSON.stringify(events).includes(mcpKey),
        "MCP stderr must never expose a secret in public events",
      );
      assert.ok(
        receipts
          .filter((receipt) => receipt.pid)
          .every((receipt) => receipt.keyMatches),
        "Only this MCP server's configured environment must reach it",
      );
      const closed = await hub.server.inject({
        method: "POST",
        url: `/v1/sessions/${session.id}/close`,
      });
      assert.equal(closed.statusCode, 200, closed.body);
      for (const receipt of receipts)
        for (const pid of [receipt.pid, receipt.childPid])
          if (pid) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      assert.deepEqual(
        await scan(path.join(dataDir, "backends"), mcpKey),
        [],
        "Native private state must not persist resolved MCP secret values",
      );
      successful = true;
    },
  );
}
