import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { SessionError, sessionId, type SessionEvent, type SessionSnapshot } from "../contracts/session.js";
import { prepareConfiguration } from "../infrastructure/session/binding-factory.js";
import { application, dataRoot, errorRecord, hash, newCommand, selection } from "./session-application.js";
import { parseConfiguration } from "../contexts/session/domain/state.js";
import { boundedWrite, MAX_CLI_INPUT_BYTES } from "./bounded-streams.js";

export async function main(args: readonly string[]): Promise<number> {
  let app: ReturnType<typeof application> | undefined;
  let current: SessionSnapshot | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  let quitting = false, interrupted = false, publicationBroken = false;
  let shutdown: Promise<void> | undefined;
  let exitCode = 0;
  let json = false;
  let rawInputBytes = 0;
  const writeOutput = (text: string) => {
    try { boundedWrite(process.stdout, text); }
    catch (error) { publicationBroken = true; beginShutdown(); throw error; }
  };
  const emit = (value: unknown) => {
    if (publicationBroken || process.stdout.destroyed) throw new SessionError("PUBLICATION_FAILED", "output stream is unavailable; committed history remains queryable");
    writeOutput(JSON.stringify(value) + "\n");
  };
  const report = (error: unknown) => {
    const fault = errorRecord(error); exitCode = 1;
    try {
      if (json && !publicationBroken) emit({ type: "error", ...(current === undefined ? {} : { sessionId: current.id }), error: fault });
      else boundedWrite(process.stderr, "HarnessGateway: " + fault.code + " — " + fault.message + "\n");
    } catch { publicationBroken = true; beginShutdown(); }
  };
  const beginShutdown = () => {
    quitting = true; lines?.close(); process.stdin.pause();
    if (app && !shutdown) { shutdown = app.runtime.close(); shutdown.catch(() => {}); }
  };
  const onSignal = () => { interrupted = true; beginShutdown(); };
  const onOutputError = () => { publicationBroken = true; beginShutdown(); };
  const onInputData = (chunk: Buffer | string) => {
    rawInputBytes += typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.length;
    if (rawInputBytes > MAX_CLI_INPUT_BYTES && !quitting) { report(new SessionError("INPUT_LIMIT", "chat raw input byte budget exhausted")); beginShutdown(); }
  };
  try {
    const { values } = parseArgs({ args: [...args], options: {
      harness: { type: "string" }, control: { type: "string" }, session: { type: "string" },
      "data-dir": { type: "string" }, cwd: { type: "string" }, manifest: { type: "string" },
      "config-home": { type: "string" }, "package-root": { type: "string", multiple: true },
      "search-dir": { type: "string", multiple: true }, "path-only": { type: "boolean" },
      prompt: { type: "string" }, "command-id": { type: "string" }, "workspace-lock-root": { type: "string" },
      json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    }, strict: true, allowPositionals: false });
    json = values.json ?? false;
    if (values.help) {
      writeOutput("HarnessGateway chat --harness <id> [--session <public-id>]\n--data-dir <path> 持久数据；--cwd <path> 工作区；--manifest <file> 目录\n--config-home <path> 私有配置；--json NDJSON公共事实\n--prompt <text> 单条消息；--command-id <key> 单条消息幂等key\n--workspace-lock-root <绝对目录> 另用工作区租约目录，不再与本机其他 Gateway 互斥同一工作区，只用于隔离的测试或刻意独立的实例\n交互命令：:harness id[:control]、:cancel、:history、:quit\n:quit仅结束本次入口；持久关闭用sessions close。跨Harness接续等级是public_context_rehydrate。\n"); return 0;
    }
    if (values.session === undefined && values.harness === undefined) throw new SessionError("INVALID_INPUT", "a new chat requires --harness; continuing requires --session");
    if (values.control !== undefined && values.harness === undefined) throw new SessionError("INVALID_INPUT", "--control requires --harness");
    if (values["command-id"] !== undefined && values.prompt === undefined) throw new SessionError("INVALID_INPUT", "--command-id is used with --prompt");
    for (const value of [values.cwd, values.manifest, values["config-home"], ...(values["package-root"] ?? []), ...(values["search-dir"] ?? [])])
      if (value !== undefined && (!value.trim() || value.length > 4096 || /[\0\r\n]/u.test(value))) throw new SessionError("INVALID_INPUT", "explicit configuration paths must be nonempty and bounded");
    process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal); process.stdout.on("error", onOutputError);
    app = application(dataRoot(values["data-dir"]), (event: SessionEvent) => {
      if (json) emit({ type: "event", event });
      else if (event.type === "run.output" && event.data.event !== null && typeof event.data.event === "object" &&
          "type" in event.data.event && event.data.event.type === "text" && "text" in event.data.event && typeof event.data.event.text === "string") writeOutput(event.data.event.text);
      else if (event.type === "run.ended" || event.type === "switch.effective" || event.type === "switch.failed" || event.type === "session.blocked")
        writeOutput("\n[" + event.type + "] " + JSON.stringify(event.data) + "\n");
    }, values["workspace-lock-root"] === undefined ? {} : { workspaceLockRoot: values["workspace-lock-root"] });
    if (values.session !== undefined) {
      current = app.runtime.read(sessionId(values.session));
      if ([values.cwd, values.manifest, values["config-home"], values["package-root"], values["search-dir"], values["path-only"]].some(value => value !== undefined)) {
        const saved = current.configuration;
        const config = await prepareConfiguration({ workspace: values.cwd === undefined ? saved.workspace : resolve(values.cwd),
          ...((values.manifest ?? saved.manifestPath) === null ? {} : { manifestPath: resolve(values.manifest ?? saved.manifestPath!) }),
          ...((values["config-home"] ?? saved.configHome) === null ? {} : { configHome: resolve(values["config-home"] ?? saved.configHome!) }),
          packageRoots: values["package-root"] === undefined ? saved.packageRoots : values["package-root"].map(path => resolve(path)),
          searchDirs: values["search-dir"] === undefined ? saved.searchDirs : values["search-dir"].map(path => resolve(path)), pathOnly: values["path-only"] ?? saved.pathOnly });
        if (JSON.stringify(parseConfiguration(config)) !== JSON.stringify(parseConfiguration(saved))) throw new SessionError("CONFIGURATION_CONFLICT", "resume cannot change its persisted workspace or configuration references");
      }
    }
    else {
      const configuration = await prepareConfiguration({ workspace: resolve(values.cwd ?? process.cwd()),
        ...(values.manifest === undefined ? {} : { manifestPath: resolve(values.manifest) }),
        ...(values["config-home"] === undefined ? {} : { configHome: resolve(values["config-home"]) }),
        packageRoots: (values["package-root"] ?? []).map(path => resolve(path)), searchDirs: (values["search-dir"] ?? []).map(path => resolve(path)), pathOnly: values["path-only"] ?? false });
      const key = values["command-id"] === undefined ? newCommand("create") : "create:" + hash(values["command-id"]);
      current = await app.runtime.create(configuration, selection(values.harness!, values.control), key);
    }
    if (current.status !== "open") throw new SessionError("SESSION_NOT_OPEN", "Session is " + current.status + "; read its persistent history with sessions show");
    if (json) emit({ type: "session", sessionId: current.id, session: current });
    else writeOutput("Session " + current.id + " · " + current.selection.harnessId + " · public_context_rehydrate\n");
    if (values.session !== undefined && values.harness !== undefined) app.runtime.switch(current.id, selection(values.harness, values.control), newCommand("switch"));
    if (values.prompt !== undefined) {
      app.runtime.send(current.id, values.prompt, values["command-id"] ?? newCommand("send"));
      await app.runtime.wait(current.id);
    } else {
      // Install the raw guard before readline can buffer an unterminated line.
      process.stdin.on("data", onInputData);
      lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
      for await (const line of lines) {
        if (quitting) break;
        if (!line.trim()) continue;
        try {
          if (line.trim() === ":quit") { beginShutdown(); break; }
          if (line.trim() === ":cancel") app.runtime.cancel(current.id, newCommand("cancel"));
          else if (line.trim() === ":history") {
            const snapshot = app.runtime.read(current.id);
            if (json) emit({ type: "history", sessionId: current.id, session: snapshot });
            else for (const message of snapshot.messages) writeOutput("\n" + message.role + " [" + message.status + "]: " + message.text + "\n");
          } else if (line.trim().startsWith(":harness ")) app.runtime.switch(current.id, selection(line.trim().slice(9).trim()), newCommand("switch"));
          else if (line.trim().startsWith(":")) throw new SessionError("INVALID_INPUT", "unknown chat command");
          else app.runtime.send(current.id, line, newCommand("send"));
        } catch (error) { report(error); }
      }
      // Ordinary EOF drains accepted input; :quit/signal explicitly cancels owned unfinished work.
      if (!quitting) await app.runtime.wait(current.id);
    }
    const final = app.runtime.read(current.id);
    if (final.status === "blocked" || final.runs.some(run => run.status === "failed" || run.status === "unknown") || final.switches.some(entry => entry.status === "failed")) exitCode = 1;
    if (json) emit({ type: "snapshot", sessionId: final.id, session: final });
  } catch (error) { report(error); }
  finally {
    lines?.close();
    if (app) {
      try { shutdown ??= app.runtime.close(); await shutdown; }
      catch (error) { report(error); }
      try { await app.management.shutdown(); }
      catch (error) { report(error); }
      try { await app.providers.shutdown(); }
      catch (error) { report(error); }
      try { app.store.close(); }
      catch (error) { report(error); }
    }
    process.stdin.off("data", onInputData); process.stdin.pause(); process.stdin.destroy();
    process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); process.stdout.off("error", onOutputError);
    if (interrupted && exitCode === 0) exitCode = 1;
  }
  return exitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
