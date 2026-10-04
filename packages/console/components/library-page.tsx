// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  FileArchive,
  FolderInput,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Streamdown } from "streamdown";
import type {
  Agent,
  LibraryAgent,
  LibraryInstructionSet,
  LibraryMcpServer,
  LibrarySkill,
} from "@harnesshub/sdk/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  bytes,
  emptyMcpForm,
  installedLibraryAgents,
  libraryAgents,
  mcpFormOf,
  mcpInput,
  noInstructionFile,
  noSse,
  rowsNamedBy,
  type McpForm,
  type SecretRow,
} from "@/lib/library";
import { failureOf, modelPlane, type Failure } from "@/lib/model-plane";
import {
  ignored,
  readZip,
  SKILL_LIMITS,
  skillOf,
  uploadInput,
  type SkillFile,
} from "@/lib/skill-upload";
import { navigate, useSearch } from "@/lib/router";
import { notify } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { LibrarySync } from "./library-sync";
import {
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorCallout,
  LoadError,
  LocalTime,
  PageHeader,
  useLoaded,
} from "./model-plane-ui";

type Tab = "instructions" | "mcp" | "skills" | "sync";
const tabs: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "instructions", label: "指令集" },
  { id: "mcp", label: "MCP 服务" },
  { id: "skills", label: "Skills" },
  { id: "sync", label: "同步到 Agent" },
];

interface LibraryData {
  instructions: LibraryInstructionSet[];
  mcp: LibraryMcpServer[];
  skills: LibrarySkill[];
  /** Empty when the daemon cannot list agents (no wiring home). */
  agents: Agent[];
}

function namesOf(agents: readonly Agent[]) {
  return new Map(agents.map((agent) => [agent.id, agent.name]));
}

function AgentTags({
  agents,
  names,
}: {
  agents: readonly LibraryAgent[];
  names: ReadonlyMap<string, string>;
}) {
  if (!agents.length) return <span className="text-subtle">未分配</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {agents.map((agent) => (
        <span key={agent} className="tag">
          {names.get(agent) ?? agent}
        </span>
      ))}
    </span>
  );
}

/**
 * The agents an item goes to. `blocked` gives the reason an agent cannot
 * take the item (the daemon refuses it too), shown next to it.
 */
function AgentChooser({
  value,
  onChange,
  names,
  blocked,
}: {
  value: readonly LibraryAgent[];
  onChange: (agents: LibraryAgent[]) => void;
  names: ReadonlyMap<string, string>;
  blocked?: (agent: LibraryAgent) => string | undefined;
}) {
  return (
    <fieldset>
      <legend className="field-label">去往的 Agent</legend>
      <div className="mt-1.5 grid gap-x-2 sm:grid-cols-3">
        {libraryAgents.map((agent) => {
          const reason = blocked?.(agent);
          return (
            <Checkbox
              key={agent}
              checked={value.includes(agent)}
              disabled={reason !== undefined && !value.includes(agent)}
              onChange={(checked) =>
                onChange(
                  checked
                    ? libraryAgents.filter(
                        (item) => item === agent || value.includes(item),
                      )
                    : value.filter((item) => item !== agent),
                )
              }
            >
              {names.get(agent) ?? agent}
              {reason ? (
                <span className="ml-1.5 text-[12px] text-subtle">{reason}</span>
              ) : null}
            </Checkbox>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Create or edit an instruction set: Markdown with a preview, and its agents. */
function InstructionDialog({
  existing,
  all,
  names,
  onClose,
  onSaved,
}: {
  existing: LibraryInstructionSet | undefined;
  all: readonly LibraryInstructionSet[];
  names: ReadonlyMap<string, string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [id, setId] = useState(existing?.id ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [text, setText] = useState<string | null>(existing ? null : "");
  const [agents, setAgents] = useState<LibraryAgent[]>(
    existing ? [...existing.agents] : [],
  );
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  useEffect(() => {
    if (!existing) return;
    let current = true;
    modelPlane()
      .library.instructions.get(existing.id)
      .then(
        (item) => {
          if (current) setText(item.text ?? "");
        },
        (reason: unknown) => {
          if (current) setFailure(failureOf(reason));
        },
      );
    return () => {
      current = false;
    };
  }, [existing]);
  // An agent gets one set: the daemon refuses one another set goes to.
  const takenBy = new Map<string, string>();
  for (const item of all)
    if (item.id !== existing?.id)
      for (const agent of item.agents) takenBy.set(agent, item.id);
  const size = new TextEncoder().encode(text ?? "").length;
  const save = () => {
    if (text === null) return;
    setBusy(true);
    setFailure(null);
    const input = {
      ...(name.trim() ? { name: name.trim() } : {}),
      text,
      agents,
    };
    const client = modelPlane();
    (existing
      ? client.library.instructions.replace(existing.id, input)
      : client.library.instructions.create(id.trim(), input)
    ).then(
      () => {
        setBusy(false);
        notify.success(
          `已保存指令集 ${existing?.id ?? id.trim()}；同步后写入 Agent`,
        );
        onSaved();
        onClose();
      },
      (reason: unknown) => {
        setBusy(false);
        setFailure(failureOf(reason));
      },
    );
  };
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : null)}>
      <DialogContent className="max-h-[94vh] overflow-y-auto sm:max-w-[820px]">
        <DialogHeader>
          <DialogTitle>
            {existing ? `编辑指令集 ${existing.id}` : "新建指令集"}
          </DialogTitle>
          <DialogDescription>
            Markdown 文本写入每个 Agent 的用户级指令文件（如
            CLAUDE.md、AGENTS.md）中一个带标记的区块，区块外的内容不动。一个
            Agent 只有一套指令集。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="field-label">
            ID
            <input
              className="field font-mono text-[13px]"
              value={id}
              readOnly={existing !== undefined}
              autoComplete="off"
              spellCheck={false}
              placeholder="team"
              onChange={(event) => setId(event.target.value)}
            />
            {existing ? null : (
              <span className="field-hint block">小写字母、数字与连字符</span>
            )}
          </label>
          <label className="field-label">
            名称
            <input
              className="field"
              value={name}
              autoComplete="off"
              placeholder={id || "团队约定"}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        </div>
        <AgentChooser
          value={agents}
          onChange={setAgents}
          names={names}
          blocked={(agent) =>
            noInstructionFile.has(agent)
              ? "没有用户级指令文件"
              : takenBy.has(agent)
                ? `已用于 ${takenBy.get(agent)}`
                : undefined
          }
        />
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="segmented" role="tablist" aria-label="编辑或预览">
              <button
                type="button"
                role="tab"
                aria-selected={view === "edit"}
                onClick={() => setView("edit")}
              >
                编辑
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "preview"}
                onClick={() => setView("preview")}
              >
                预览
              </button>
            </div>
            <span
              className={cn(
                "text-[12px] text-subtle",
                size > 256 * 1024 && "text-danger",
              )}
            >
              {bytes(size)} / 256 KiB
            </span>
          </div>
          {text === null ? (
            <Skeleton className="h-72 w-full" />
          ) : view === "edit" ? (
            <textarea
              className="field min-h-[320px] font-mono text-[13px]"
              value={text}
              aria-label="指令集 Markdown"
              spellCheck={false}
              placeholder={"# 团队约定\n\n- 提交前运行测试\n- 回答使用中文"}
              onChange={(event) => setText(event.target.value)}
            />
          ) : (
            <div className="min-h-[320px] rounded-[10px] border p-4">
              {text.trim() ? (
                <Streamdown className="markdown-content" mode="static">
                  {text}
                </Streamdown>
              ) : (
                <p className="text-[13px] text-subtle">没有内容</p>
              )}
            </div>
          )}
        </div>
        <ErrorCallout failure={failure} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={
              busy || text === null || !text.trim() || (!existing && !id.trim())
            }
            onClick={save}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InstructionsTab({
  data,
  names,
  reload,
}: {
  data: LibraryData;
  names: ReadonlyMap<string, string>;
  reload: () => void;
}) {
  const [editing, setEditing] = useState<{
    item: LibraryInstructionSet | undefined;
  } | null>(null);
  const [removing, setRemoving] = useState<LibraryInstructionSet | null>(null);
  return (
    <>
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setEditing({ item: undefined })}>
          <Plus />
          新建指令集
        </Button>
      </div>
      {data.instructions.length ? (
        <div className="panel overflow-x-auto">
          <table className="data-table min-w-[640px]">
            <thead>
              <tr>
                <th>指令集</th>
                <th>Agent</th>
                <th>大小</th>
                <th>修改</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.instructions.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className="block">{item.name}</span>
                    <span className="font-mono text-[12px] text-subtle">
                      {item.id}
                    </span>
                  </td>
                  <td>
                    <AgentTags agents={item.agents} names={names} />
                  </td>
                  <td className="text-[12.5px]">{bytes(item.size)}</td>
                  <td className="text-[12.5px]">
                    <LocalTime value={item.updatedAt} />
                  </td>
                  <td className="w-[96px] text-right whitespace-nowrap">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`编辑 ${item.id}`}
                      onClick={() => setEditing({ item })}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`删除 ${item.id}`}
                      onClick={() => setRemoving(item)}
                    >
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={BookOpen}
          title="还没有指令集"
          action={
            <Button size="sm" onClick={() => setEditing({ item: undefined })}>
              <Plus />
              新建指令集
            </Button>
          }
        >
          把团队约定、代码风格等写成一份 Markdown，同步到各个 Agent
          的用户级指令文件。
        </EmptyState>
      )}
      {editing ? (
        <InstructionDialog
          existing={editing.item}
          all={data.instructions}
          names={names}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={`删除指令集 ${removing?.id ?? ""}`}
        description="从 Library 删除；下一次同步时从各个 Agent 的文件中取出它的区块。"
        action="删除"
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await modelPlane().library.instructions.remove(removing.id);
          notify.success(`已删除指令集 ${removing.id}`);
          reload();
        }}
      />
    </>
  );
}

const secretKinds: ReadonlyArray<{ id: SecretRow["kind"]; label: string }> = [
  { id: "env", label: "环境变量" },
  { id: "file", label: "文件" },
  { id: "value", label: "新值" },
];

/**
 * Secrets of an MCP server by name: an environment variable or a file on
 * the daemon's machine, a value sent once to the secret store, or a stored
 * secret that stays as it is (never shown).
 */
function SecretRows({
  label,
  rows,
  onChange,
  marked,
  field,
}: {
  label: string;
  rows: SecretRow[];
  onChange: (rows: SecretRow[]) => void;
  marked: ReadonlySet<string>;
  field: "secretEnv" | "secretHeaders";
}) {
  const update = (index: number, patch: Partial<SecretRow>) =>
    onChange(
      rows.map((row, at) => (at === index ? { ...row, ...patch } : row)),
    );
  return (
    <fieldset className="space-y-2">
      <legend className="field-label flex w-full items-center justify-between">
        {label}
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            onChange([...rows, { name: "", kind: "env", value: "" }])
          }
        >
          <Plus />
          添加
        </Button>
      </legend>
      {rows.map((row, index) => {
        const invalid = marked.has(`${field}:${row.name.trim()}`);
        return (
          <div
            key={index}
            className={cn(
              "grid gap-2 rounded-[10px] sm:grid-cols-[1fr_120px_1.4fr_auto]",
              invalid &&
                "ring-2 ring-(--danger) ring-offset-2 ring-offset-(--card)",
            )}
          >
            <input
              className="field mt-0 font-mono text-[13px]"
              value={row.name}
              aria-label="名称"
              aria-invalid={invalid}
              placeholder={
                field === "secretEnv" ? "GITHUB_TOKEN" : "Authorization"
              }
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update(index, { name: event.target.value })}
            />
            <select
              className="field mt-0"
              aria-label="来源"
              value={row.kind}
              onChange={(event) =>
                update(index, {
                  kind: event.target.value as SecretRow["kind"],
                  value: "",
                })
              }
            >
              {row.stored ? <option value="keep">已保存</option> : null}
              {secretKinds.map((kind) => (
                <option key={kind.id} value={kind.id}>
                  {kind.label}
                </option>
              ))}
            </select>
            {row.kind === "keep" ? (
              <p className="field mt-0 flex items-center text-[13px]">
                已保存在秘密存储中，不显示
              </p>
            ) : (
              <input
                className="field mt-0 font-mono text-[13px]"
                aria-label="值"
                type={row.kind === "value" ? "password" : "text"}
                value={row.value}
                autoComplete={row.kind === "value" ? "new-password" : "off"}
                spellCheck={false}
                placeholder={
                  row.kind === "env"
                    ? "变量名，例如 GITHUB_TOKEN"
                    : row.kind === "file"
                      ? "绝对路径，例如 /home/me/.secrets/github"
                      : "只发送一次，存入秘密存储"
                }
                onChange={(event) =>
                  update(index, { value: event.target.value })
                }
              />
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              className="self-center"
              aria-label={`移除 ${row.name || "这一行"}`}
              onClick={() => onChange(rows.filter((_, at) => at !== index))}
            >
              <X />
            </Button>
          </div>
        );
      })}
    </fieldset>
  );
}

/** A refused secret: what the rule protects, with the daemon's reason. */
function SecretRuleError({ failure }: { failure: Failure }) {
  return (
    <div role="alert" className="callout error">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">不能引用 HarnessHub 自己的凭据</p>
        <p className="font-mono text-[12.5px]">{failure.message}</p>
        <p>
          MCP 服务的秘密不能是：HH_ 或 HARNESSHUB_
          开头的环境变量；数据目录与配置目录中的文件；任一 provider
          凭据使用的变量、文件或秘密；Gateway Key、管理令牌或 provider Key
          的值。请为这个服务另建一个专用的凭据。什么都没有保存。
        </p>
      </div>
    </div>
  );
}

function McpDialog({
  existing,
  names,
  onClose,
  onSaved,
}: {
  existing: LibraryMcpServer | undefined;
  names: ReadonlyMap<string, string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<McpForm>(() =>
    existing ? mcpFormOf(existing) : emptyMcpForm(),
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const set = <K extends keyof McpForm>(key: K, value: McpForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const stdio = form.transport === "stdio";
  const marked = failure
    ? rowsNamedBy(failure.message, form)
    : new Set<string>();
  const plainField = failure?.message.match(
    /^(env|headers)\.(\S+) carries a credential/,
  );
  const save = () => {
    let input;
    try {
      input = mcpInput(form);
    } catch (error) {
      setFailure({
        message: error instanceof Error ? error.message : String(error),
        fields: {},
        references: [],
      });
      return;
    }
    setBusy(true);
    setFailure(null);
    const client = modelPlane();
    (existing
      ? client.library.mcp.replace(existing.name, input)
      : client.library.mcp.create(form.name.trim(), input)
    ).then(
      () => {
        setBusy(false);
        notify.success(
          `已保存 MCP 服务 ${existing?.name ?? form.name.trim()}；同步后写入 Agent`,
        );
        onSaved();
        onClose();
      },
      (reason: unknown) => {
        setBusy(false);
        setFailure(failureOf(reason));
      },
    );
  };
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : null)}>
      <DialogContent className="max-h-[94vh] overflow-y-auto sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>
            {existing ? `编辑 MCP 服务 ${existing.name}` : "添加 MCP 服务"}
          </DialogTitle>
          <DialogDescription>
            Library
            不保存秘密值：秘密以环境变量、文件或秘密存储的引用登记；Agent
            支持变量引用时只写引用。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="field-label">
            名称
            <input
              className="field font-mono text-[13px]"
              value={form.name}
              readOnly={existing !== undefined}
              autoComplete="off"
              spellCheck={false}
              placeholder="github"
              onChange={(event) => set("name", event.target.value)}
            />
          </label>
          <div className="field-label">
            传输
            <div className="mt-1.5">
              <div className="segmented" role="tablist" aria-label="传输">
                {(["stdio", "http", "sse"] as const).map((transport) => (
                  <button
                    key={transport}
                    type="button"
                    role="tab"
                    aria-selected={form.transport === transport}
                    onClick={() => set("transport", transport)}
                  >
                    {transport === "stdio"
                      ? "本地命令"
                      : transport === "http"
                        ? "HTTP"
                        : "SSE"}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
        {stdio ? (
          <>
            <label className="field-label">
              命令
              <input
                className="field font-mono text-[13px]"
                value={form.command}
                autoComplete="off"
                spellCheck={false}
                placeholder="npx"
                onChange={(event) => set("command", event.target.value)}
              />
            </label>
            <label className="field-label">
              参数
              <textarea
                className="field min-h-[72px] font-mono text-[13px]"
                value={form.args}
                spellCheck={false}
                placeholder={"-y\n@modelcontextprotocol/server-github"}
                onChange={(event) => set("args", event.target.value)}
              />
              <span className="field-hint block">每行一个参数</span>
            </label>
            <label className="field-label">
              环境变量
              <textarea
                className="field min-h-[60px] font-mono text-[13px]"
                value={form.env}
                spellCheck={false}
                aria-invalid={plainField?.[1] === "env"}
                placeholder="LOG_LEVEL=info"
                onChange={(event) => set("env", event.target.value)}
              />
              <span className="field-hint block">
                每行 NAME=value，只用于不是秘密的值；名称像 …_TOKEN、…_API_KEY
                的会被拒绝，请改在下面登记为秘密。
              </span>
            </label>
            <SecretRows
              label="秘密环境变量"
              field="secretEnv"
              rows={form.secretEnv}
              marked={marked}
              onChange={(rows) => set("secretEnv", rows)}
            />
          </>
        ) : (
          <>
            <label className="field-label">
              地址
              <input
                className="field font-mono text-[13px]"
                value={form.url}
                autoComplete="off"
                spellCheck={false}
                placeholder="https://mcp.example.com/mcp"
                onChange={(event) => set("url", event.target.value)}
              />
            </label>
            <label className="field-label">
              请求头
              <textarea
                className="field min-h-[60px] font-mono text-[13px]"
                value={form.headers}
                spellCheck={false}
                aria-invalid={plainField?.[1] === "headers"}
                placeholder="X-Team: platform"
                onChange={(event) => set("headers", event.target.value)}
              />
              <span className="field-hint block">
                每行 Name: value，只用于不是秘密的值；Authorization、Cookie
                等会被拒绝，请改在下面登记为秘密。
              </span>
            </label>
            <SecretRows
              label="秘密请求头"
              field="secretHeaders"
              rows={form.secretHeaders}
              marked={marked}
              onChange={(rows) => set("secretHeaders", rows)}
            />
          </>
        )}
        <AgentChooser
          value={form.agents}
          onChange={(agents) => set("agents", agents)}
          names={names}
          blocked={(agent) =>
            form.transport === "sse" && noSse.has(agent)
              ? "不支持 SSE"
              : undefined
          }
        />
        {failure?.code === "SECRET_REF_FORBIDDEN" ? (
          <SecretRuleError failure={failure} />
        ) : (
          <ErrorCallout failure={failure} />
        )}
        {plainField ? (
          <p className="callout info">
            把 <span className="font-mono">{plainField[2]}</span> 从
            {plainField[1] === "env" ? "环境变量" : "请求头"}
            移到
            {plainField[1] === "env" ? "秘密环境变量" : "秘密请求头"}
            ，选择它的来源（环境变量、文件或新值）。
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy || !form.name.trim()} onClick={save}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function McpTab({
  data,
  names,
  reload,
}: {
  data: LibraryData;
  names: ReadonlyMap<string, string>;
  reload: () => void;
}) {
  const [editing, setEditing] = useState<{
    item: LibraryMcpServer | undefined;
  } | null>(null);
  const [removing, setRemoving] = useState<LibraryMcpServer | null>(null);
  return (
    <>
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setEditing({ item: undefined })}>
          <Plus />
          添加 MCP 服务
        </Button>
      </div>
      {data.mcp.length ? (
        <div className="panel overflow-x-auto">
          <table className="data-table min-w-[720px]">
            <thead>
              <tr>
                <th>服务</th>
                <th>命令或地址</th>
                <th>秘密</th>
                <th>Agent</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.mcp.map((item) => {
                const secrets = {
                  ...item.secretEnv,
                  ...item.secretHeaders,
                };
                return (
                  <tr key={item.name}>
                    <td>
                      <span className="block font-mono text-[13px]">
                        {item.name}
                      </span>
                      <span className="text-[12px] text-subtle">
                        {item.transport}
                      </span>
                    </td>
                    <td className="max-w-[260px] font-mono text-[12px] break-all">
                      {item.transport === "stdio"
                        ? [item.command, ...(item.args ?? [])].join(" ")
                        : item.url}
                    </td>
                    <td className="text-[12px]">
                      {Object.keys(secrets).length ? (
                        <span className="flex flex-wrap gap-1">
                          {Object.entries(secrets).map(([name, ref]) => (
                            <span
                              key={name}
                              className="tag font-mono"
                              title={
                                ref.kind === "store"
                                  ? "秘密存储"
                                  : `${ref.kind}:${ref.value}`
                              }
                            >
                              {name}
                              <span className="text-subtle">
                                {ref.kind === "store" ? "存储" : ref.kind}
                              </span>
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-subtle">无</span>
                      )}
                    </td>
                    <td>
                      <AgentTags agents={item.agents} names={names} />
                    </td>
                    <td className="w-[96px] text-right whitespace-nowrap">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`编辑 ${item.name}`}
                        onClick={() => setEditing({ item })}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`删除 ${item.name}`}
                        onClick={() => setRemoving(item)}
                      >
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={Server}
          title="还没有 MCP 服务"
          action={
            <Button size="sm" onClick={() => setEditing({ item: undefined })}>
              <Plus />
              添加 MCP 服务
            </Button>
          }
        >
          登记一次本地命令或远程 MCP 服务，按各 Agent 自己的格式写入它们的配置。
        </EmptyState>
      )}
      {editing ? (
        <McpDialog
          existing={editing.item}
          names={names}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={`删除 MCP 服务 ${removing?.name ?? ""}`}
        description="从 Library 删除，秘密存储中它的秘密一并删除；下一次同步时从各个 Agent 的配置中取出。"
        action="删除"
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await modelPlane().library.mcp.remove(removing.name);
          notify.success(`已删除 MCP 服务 ${removing.name}`);
          reload();
        }}
      />
    </>
  );
}

type Picked =
  | { state: "none" }
  | { state: "reading" }
  | { state: "error"; message: string }
  | {
      state: "ready";
      from: string;
      name: string;
      files: SkillFile[];
      size: number;
      problems: string[];
    };

/**
 * Add a skill: upload a folder or zip picked in the browser (checked
 * against the 500-file and 20 MiB limits before it is sent), or import a
 * directory on the daemon's machine by its path.
 */
function SkillImportDialog({
  names,
  onClose,
  onSaved,
}: {
  names: ReadonlyMap<string, string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<"upload" | "path">("upload");
  const [source, setSource] = useState("");
  const [picked, setPicked] = useState<Picked>({ state: "none" });
  const [name, setName] = useState("");
  const [agents, setAgents] = useState<LibraryAgent[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const read = (
    from: string,
    load: () => Promise<SkillFile[]>,
    fallback: string,
  ) => {
    setPicked({ state: "reading" });
    setFailure(null);
    load().then(
      (files) => {
        const skill = skillOf(files, fallback);
        setName(skill.name);
        setPicked({ state: "ready", from, ...skill });
      },
      (reason: unknown) =>
        setPicked({
          state: "error",
          message: reason instanceof Error ? reason.message : String(reason),
        }),
    );
  };
  const pickFolder = (list: FileList | null) => {
    const all = [...(list ?? [])];
    if (!all.length) return;
    const top = all[0]!.webkitRelativePath.split("/")[0] ?? "";
    const files = all.filter(
      (file) => !ignored(file.webkitRelativePath || file.name),
    );
    read(
      `文件夹 ${top}`,
      async () => {
        // Checked before reading, so a large folder is never loaded.
        const size = files.reduce((sum, file) => sum + file.size, 0);
        if (files.length > SKILL_LIMITS.files)
          throw new Error(
            `文件夹有 ${files.length} 个文件，超过 ${SKILL_LIMITS.files} 个`,
          );
        if (size > SKILL_LIMITS.bytes)
          throw new Error(`文件夹共 ${bytes(size)}，超过 20 MiB`);
        return Promise.all(
          files.map(async (file) => ({
            path: file.webkitRelativePath || file.name,
            bytes: new Uint8Array(await file.arrayBuffer()),
            // A browser does not say whether a file is executable.
            exec: false,
          })),
        );
      },
      top,
    );
  };
  const pickZip = (file: File | undefined) => {
    if (!file) return;
    read(
      `压缩包 ${file.name}`,
      async () => readZip(await file.arrayBuffer()),
      file.name.replace(/\.zip$/i, ""),
    );
  };
  const done = (skill: LibrarySkill, verb: string) => {
    setBusy(false);
    notify.success(`已${verb} Skill ${skill.name}（${skill.files} 个文件）`);
    onSaved();
    onClose();
  };
  const save = () => {
    setBusy(true);
    setFailure(null);
    const skills = modelPlane().library.skills;
    (mode === "upload" && picked.state === "ready"
      ? skills
          .upload(uploadInput(name.trim(), picked.files, agents))
          .then((skill) => done(skill, "上传"))
      : skills
          .import(source.trim(), agents)
          .then((skill) => done(skill, "导入"))
    ).catch((reason: unknown) => {
      setBusy(false);
      setFailure(failureOf(reason));
    });
  };
  const ready =
    mode === "upload"
      ? picked.state === "ready" && !picked.problems.length && !!name.trim()
      : !!source.trim();
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : null)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[620px] [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>添加 Skill</DialogTitle>
          <DialogDescription>
            Skill 是一个含 SKILL.md 的目录（YAML front matter 的 name
            等于目录名，并有 description），最多 500 个文件、20
            MiB，不能含链接。同名 Skill 再次添加成为新版本。
          </DialogDescription>
        </DialogHeader>
        <div className="segmented" role="tablist" aria-label="Skill 来源">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "upload"}
            disabled={busy}
            onClick={() => setMode("upload")}
          >
            上传文件夹或 zip
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "path"}
            disabled={busy}
            onClick={() => setMode("path")}
          >
            守护进程上的目录
          </button>
        </div>
        {mode === "upload" ? (
          <div className="space-y-3">
            <input
              ref={(node) => {
                // Not a React attribute: the browser's folder picker.
                if (node) node.webkitdirectory = true;
                folderInput.current = node;
              }}
              type="file"
              multiple
              className="sr-only"
              aria-label="选择 Skill 文件夹"
              onChange={(event) => {
                pickFolder(event.target.files);
                event.target.value = "";
              }}
            />
            <input
              ref={zipInput}
              type="file"
              accept=".zip,application/zip"
              className="sr-only"
              aria-label="选择 Skill 压缩包"
              onChange={(event) => {
                pickZip(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy || picked.state === "reading"}
                onClick={() => folderInput.current?.click()}
              >
                <FolderOpen />
                选择文件夹
              </Button>
              <Button
                variant="outline"
                disabled={busy || picked.state === "reading"}
                onClick={() => zipInput.current?.click()}
              >
                <FileArchive />
                选择 zip
              </Button>
            </div>
            {picked.state === "reading" ? (
              <p
                className="flex items-center gap-2 text-[13px] text-muted-foreground"
                role="status"
              >
                <Loader2 className="size-4 animate-spin" />
                正在读取文件…
              </p>
            ) : picked.state === "error" ? (
              <p role="alert" className="callout error">
                {picked.message}
              </p>
            ) : picked.state === "ready" ? (
              <div className="space-y-2 rounded-xl border p-3">
                <p className="text-[13px]">
                  {picked.from}：{picked.files.length} 个文件，
                  {bytes(picked.size)}
                  {picked.files.some((file) => file.exec)
                    ? `，${picked.files.filter((file) => file.exec).length} 个可执行`
                    : ""}
                </p>
                <label className="field-label">
                  名称
                  <input
                    className="field font-mono text-[13px]"
                    value={name}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <span className="field-hint block">
                    与 SKILL.md 中的 name 相同（小写字母、数字与连字符）。
                  </span>
                </label>
                <ul className="max-h-[22vh] overflow-y-auto font-mono text-[12px] text-muted-foreground">
                  {picked.files.slice(0, 50).map((file) => (
                    <li key={file.path} className="truncate">
                      {file.path}
                      {file.exec ? (
                        <span className="ml-1.5 text-subtle">可执行</span>
                      ) : null}
                    </li>
                  ))}
                  {picked.files.length > 50 ? (
                    <li>…… 另有 {picked.files.length - 50} 个</li>
                  ) : null}
                </ul>
                {picked.problems.length ? (
                  <ul
                    role="alert"
                    className="callout error block list-disc space-y-0.5 pl-8"
                  >
                    {picked.problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">
                文件在浏览器中读取，检查文件数与大小后上传；从文件夹上传时浏览器不提供可执行权限，需要可执行权限的脚本请用
                zip 打包。
              </p>
            )}
          </div>
        ) : (
          <label className="field-label">
            目录的绝对路径
            <input
              className="field font-mono text-[13px]"
              value={source}
              autoComplete="off"
              spellCheck={false}
              placeholder="/Users/me/skills/pdf-tools"
              onChange={(event) => setSource(event.target.value)}
            />
            <span className="field-hint block">守护进程所在电脑上的路径。</span>
          </label>
        )}
        <AgentChooser value={agents} onChange={setAgents} names={names} />
        <ErrorCallout failure={failure} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy || !ready} onClick={save}>
            {busy ? <Loader2 className="animate-spin" /> : <FolderInput />}
            {mode === "upload" ? "上传" : "导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SkillAgentsDialog({
  skill,
  names,
  onClose,
  onSaved,
}: {
  skill: LibrarySkill;
  names: ReadonlyMap<string, string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [agents, setAgents] = useState<LibraryAgent[]>([...skill.agents]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : null)}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{skill.name} 去往的 Agent</DialogTitle>
          <DialogDescription>{skill.description}</DialogDescription>
        </DialogHeader>
        <AgentChooser value={agents} onChange={setAgents} names={names} />
        <ErrorCallout failure={failure} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setFailure(null);
              modelPlane()
                .library.skills.setAgents(skill.name, agents)
                .then(
                  () => {
                    setBusy(false);
                    notify.success(`已更新 ${skill.name} 的 Agent`);
                    onSaved();
                    onClose();
                  },
                  (reason: unknown) => {
                    setBusy(false);
                    setFailure(failureOf(reason));
                  },
                );
            }}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SkillsTab({
  data,
  names,
  reload,
}: {
  data: LibraryData;
  names: ReadonlyMap<string, string>;
  reload: () => void;
}) {
  const [importing, setImporting] = useState(false);
  const [assigning, setAssigning] = useState<LibrarySkill | null>(null);
  const [removing, setRemoving] = useState<LibrarySkill | null>(null);
  return (
    <>
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setImporting(true)}>
          <FolderInput />
          添加 Skill
        </Button>
      </div>
      {data.skills.length ? (
        <div className="panel overflow-x-auto">
          <table className="data-table min-w-[720px]">
            <thead>
              <tr>
                <th>Skill</th>
                <th>文件</th>
                <th>Agent</th>
                <th>修改</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.skills.map((skill) => (
                <tr key={skill.name}>
                  <td className="max-w-[320px]">
                    <span className="block font-mono text-[13px]">
                      {skill.name}
                    </span>
                    <span className="line-clamp-2 text-[12px] text-muted-foreground">
                      {skill.description}
                    </span>
                  </td>
                  <td className="text-[12.5px] whitespace-nowrap">
                    {skill.files} 个 · {bytes(skill.size)}
                  </td>
                  <td>
                    <AgentTags agents={skill.agents} names={names} />
                  </td>
                  <td className="text-[12.5px]">
                    <LocalTime value={skill.updatedAt} />
                  </td>
                  <td className="w-[96px] text-right whitespace-nowrap">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`${skill.name} 的 Agent`}
                      onClick={() => setAssigning(skill)}
                    >
                      <Users />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`删除 ${skill.name}`}
                      onClick={() => setRemoving(skill)}
                    >
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={Sparkles}
          title="还没有 Skill"
          action={
            <Button size="sm" onClick={() => setImporting(true)}>
              <FolderInput />
              添加 Skill
            </Button>
          }
        >
          导入符合 Agent Skills 规范的目录，链接到各个 Agent 的 Skills 目录。
        </EmptyState>
      )}
      {importing ? (
        <SkillImportDialog
          names={names}
          onClose={() => setImporting(false)}
          onSaved={reload}
        />
      ) : null}
      {assigning ? (
        <SkillAgentsDialog
          skill={assigning}
          names={names}
          onClose={() => setAssigning(null)}
          onSaved={reload}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={`删除 Skill ${removing?.name ?? ""}`}
        description="从 Library 删除；下一次同步时从各个 Agent 的 Skills 目录中移除 HarnessHub 放置的链接或副本。"
        action="删除"
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await modelPlane().library.skills.remove(removing.name);
          notify.success(`已删除 Skill ${removing.name}`);
          reload();
        }}
      />
    </>
  );
}

/**
 * The Library (docs/library.md): instruction sets, MCP servers and skills
 * kept by HarnessHub, and their sync into the agents on this machine with a
 * preview of every file. `?tab=` names the open tab.
 */
export function LibraryPage() {
  const load = useCallback(async (): Promise<LibraryData> => {
    const client = modelPlane();
    const [instructions, mcp, skills, agents] = await Promise.all([
      client.library.instructions.list(),
      client.library.mcp.list(),
      client.library.skills.list(),
      client.agents.list().then(
        (page) => page.items,
        () => [],
      ),
    ]);
    return {
      instructions: instructions.items,
      mcp: mcp.items,
      skills: skills.items,
      agents,
    };
  }, []);
  const [data, reload] = useLoaded(load);
  const search = useSearch();
  const requested = new URLSearchParams(search).get("tab");
  const tab: Tab = tabs.some((item) => item.id === requested)
    ? (requested as Tab)
    : "instructions";
  const names = namesOf(data.state === "ready" ? data.value.agents : []);
  return (
    <div className="page-body">
      <div className="page-column max-w-[1040px]">
        <PageHeader
          title="Library"
          lede="指令集、MCP 服务与 Skills 保存在 HarnessHub 中，预览改动后写入本机各个 Agent 自己的位置与格式。"
        >
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="刷新"
            onClick={reload}
          >
            <RefreshCw />
          </Button>
        </PageHeader>
        <div className="mt-5">
          <div className="segmented" role="tablist" aria-label="Library">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={item.id === tab}
                onClick={() =>
                  navigate("library", {
                    search: item.id === "instructions" ? "" : `?tab=${item.id}`,
                    replace: true,
                  })
                }
              >
                {item.label}
                {data.state === "ready" && item.id !== "sync" ? (
                  <span className="ml-1 text-subtle">
                    {data.value[item.id].length}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-4 space-y-3">
          {data.state === "loading" ? (
            <div
              className="panel space-y-3 p-5"
              role="status"
              aria-label="正在读取"
            >
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : data.state === "error" ? (
            <LoadError message={data.message} retry={reload} />
          ) : tab === "instructions" ? (
            <InstructionsTab data={data.value} names={names} reload={reload} />
          ) : tab === "mcp" ? (
            <McpTab data={data.value} names={names} reload={reload} />
          ) : tab === "skills" ? (
            <SkillsTab data={data.value} names={names} reload={reload} />
          ) : (
            <section className="panel space-y-3 p-5">
              <p className="text-[13px] text-muted-foreground">
                先预览每个 Agent
                的文件改动，确认后按这份预览写入；预览之后文件又被改动的 Agent
                什么都不写。HarnessHub 只拥有自己写入的部分，从 Library
                删除的条目在同步时被取出。
              </p>
              <LibrarySync
                agents={data.value.agents}
                initial={installedLibraryAgents(data.value.agents)}
              />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
