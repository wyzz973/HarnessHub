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
import { t } from "@/lib/i18n";
import { tr } from "@/lib/i18n-react";
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
const tabs: readonly Tab[] = ["instructions", "mcp", "skills", "sync"];

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
  if (!agents.length)
    return <span className="text-subtle">{t("library.unassigned")}</span>;
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
      <legend className="field-label">{t("library.agentsLegend")}</legend>
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
          t("library.instructions.saved", { id: existing?.id ?? id.trim() }),
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
            {existing
              ? t("library.instructions.edit", { id: existing.id })
              : t("library.instructions.new")}
          </DialogTitle>
          <DialogDescription>
            {t("library.instructions.description")}
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
              <span className="field-hint block">{t("library.idHint")}</span>
            )}
          </label>
          <label className="field-label">
            {t("library.name")}
            <input
              className="field"
              value={name}
              autoComplete="off"
              placeholder={id || t("library.instructions.namePlaceholder")}
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
              ? t("library.instructions.noFile")
              : takenBy.has(agent)
                ? t("library.instructions.takenBy", {
                    id: takenBy.get(agent) ?? "",
                  })
                : undefined
          }
        />
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div
              className="segmented"
              role="tablist"
              aria-label={t("library.instructions.view")}
            >
              <button
                type="button"
                role="tab"
                aria-selected={view === "edit"}
                onClick={() => setView("edit")}
              >
                {t("library.instructions.editTab")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "preview"}
                onClick={() => setView("preview")}
              >
                {t("library.instructions.previewTab")}
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
              aria-label={t("library.instructions.markdown")}
              spellCheck={false}
              placeholder={t("library.instructions.placeholder")}
              onChange={(event) => setText(event.target.value)}
            />
          ) : (
            <div className="min-h-[320px] rounded-[10px] border p-4">
              {text.trim() ? (
                <Streamdown className="markdown-content" mode="static">
                  {text}
                </Streamdown>
              ) : (
                <p className="text-[13px] text-subtle">
                  {t("library.instructions.empty")}
                </p>
              )}
            </div>
          )}
        </div>
        <ErrorCallout failure={failure} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={
              busy || text === null || !text.trim() || (!existing && !id.trim())
            }
            onClick={save}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("library.save")}
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
          {t("library.instructions.new")}
        </Button>
      </div>
      {data.instructions.length ? (
        <div className="panel overflow-x-auto">
          <table className="data-table min-w-[640px]">
            <thead>
              <tr>
                <th>{t("library.instructions.column")}</th>
                <th>Agent</th>
                <th>{t("library.size")}</th>
                <th>{t("library.modified")}</th>
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
                      aria-label={t("library.editItem", { name: item.id })}
                      onClick={() => setEditing({ item })}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("library.deleteItem", { name: item.id })}
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
          title={t("library.instructions.emptyTitle")}
          action={
            <Button size="sm" onClick={() => setEditing({ item: undefined })}>
              <Plus />
              {t("library.instructions.new")}
            </Button>
          }
        >
          {t("library.instructions.emptyBody")}
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
        title={t("library.instructions.deleteTitle", {
          id: removing?.id ?? "",
        })}
        description={t("library.instructions.deleteBody")}
        action={t("library.delete")}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await modelPlane().library.instructions.remove(removing.id);
          notify.success(
            t("library.instructions.deleted", { id: removing.id }),
          );
          reload();
        }}
      />
    </>
  );
}

const secretKinds: readonly Exclude<SecretRow["kind"], "keep">[] = [
  "env",
  "file",
  "value",
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
          {t("library.add")}
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
              aria-label={t("library.name")}
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
              aria-label={t("library.secret.source")}
              value={row.kind}
              onChange={(event) =>
                update(index, {
                  kind: event.target.value as SecretRow["kind"],
                  value: "",
                })
              }
            >
              {row.stored ? (
                <option value="keep">{t("library.secretKind.keep")}</option>
              ) : null}
              {secretKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`library.secretKind.${kind}`)}
                </option>
              ))}
            </select>
            {row.kind === "keep" ? (
              <p className="field mt-0 flex items-center text-[13px]">
                {t("library.secret.storedHidden")}
              </p>
            ) : (
              <input
                className="field mt-0 font-mono text-[13px]"
                aria-label={t("library.secret.value")}
                type={row.kind === "value" ? "password" : "text"}
                value={row.value}
                autoComplete={row.kind === "value" ? "new-password" : "off"}
                spellCheck={false}
                placeholder={
                  row.kind === "env"
                    ? t("library.secret.envPlaceholder")
                    : row.kind === "file"
                      ? t("library.secret.filePlaceholder")
                      : t("library.secret.valuePlaceholder")
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
              aria-label={t("library.secret.remove", {
                name: row.name || t("library.secret.thisRow"),
              })}
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
        <p className="font-medium">{t("library.secretRule.title")}</p>
        <p className="font-mono text-[12.5px]">{failure.message}</p>
        <p>{t("library.secretRule.body")}</p>
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
          t("library.mcp.saved", { name: existing?.name ?? form.name.trim() }),
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
            {existing
              ? t("library.mcp.edit", { name: existing.name })
              : t("library.mcp.add")}
          </DialogTitle>
          <DialogDescription>{t("library.mcp.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="field-label">
            {t("library.name")}
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
            {t("library.mcp.transport")}
            <div className="mt-1.5">
              <div
                className="segmented"
                role="tablist"
                aria-label={t("library.mcp.transport")}
              >
                {(["stdio", "http", "sse"] as const).map((transport) => (
                  <button
                    key={transport}
                    type="button"
                    role="tab"
                    aria-selected={form.transport === transport}
                    onClick={() => set("transport", transport)}
                  >
                    {transport === "stdio"
                      ? t("library.mcp.stdio")
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
              {t("library.mcp.command")}
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
              {t("library.mcp.args")}
              <textarea
                className="field min-h-[72px] font-mono text-[13px]"
                value={form.args}
                spellCheck={false}
                placeholder={"-y\n@modelcontextprotocol/server-github"}
                onChange={(event) => set("args", event.target.value)}
              />
              <span className="field-hint block">
                {t("library.mcp.argsHint")}
              </span>
            </label>
            <label className="field-label">
              {t("library.mcp.env")}
              <textarea
                className="field min-h-[60px] font-mono text-[13px]"
                value={form.env}
                spellCheck={false}
                aria-invalid={plainField?.[1] === "env"}
                placeholder="LOG_LEVEL=info"
                onChange={(event) => set("env", event.target.value)}
              />
              <span className="field-hint block">
                {t("library.mcp.envHint")}
              </span>
            </label>
            <SecretRows
              label={t("library.mcp.secretEnv")}
              field="secretEnv"
              rows={form.secretEnv}
              marked={marked}
              onChange={(rows) => set("secretEnv", rows)}
            />
          </>
        ) : (
          <>
            <label className="field-label">
              {t("library.mcp.url")}
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
              {t("library.mcp.headers")}
              <textarea
                className="field min-h-[60px] font-mono text-[13px]"
                value={form.headers}
                spellCheck={false}
                aria-invalid={plainField?.[1] === "headers"}
                placeholder="X-Team: platform"
                onChange={(event) => set("headers", event.target.value)}
              />
              <span className="field-hint block">
                {t("library.mcp.headersHint")}
              </span>
            </label>
            <SecretRows
              label={t("library.mcp.secretHeaders")}
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
              ? t("library.mcp.noSse")
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
            {tr(
              plainField[1] === "env"
                ? "library.mcp.moveEnv"
                : "library.mcp.moveHeader",
              { name: <span className="font-mono">{plainField[2]}</span> },
            )}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy || !form.name.trim()} onClick={save}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("library.save")}
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
          {t("library.mcp.add")}
        </Button>
      </div>
      {data.mcp.length ? (
        <div className="panel overflow-x-auto">
          <table className="data-table min-w-[720px]">
            <thead>
              <tr>
                <th>{t("library.mcp.columnServer")}</th>
                <th>{t("library.mcp.columnTarget")}</th>
                <th>{t("library.mcp.columnSecrets")}</th>
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
                                  ? t("library.mcp.secretStore")
                                  : `${ref.kind}:${ref.value}`
                              }
                            >
                              {name}
                              <span className="text-subtle">
                                {ref.kind === "store"
                                  ? t("library.mcp.store")
                                  : ref.kind}
                              </span>
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-subtle">{t("library.none")}</span>
                      )}
                    </td>
                    <td>
                      <AgentTags agents={item.agents} names={names} />
                    </td>
                    <td className="w-[96px] text-right whitespace-nowrap">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("library.editItem", {
                          name: item.name,
                        })}
                        onClick={() => setEditing({ item })}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("library.deleteItem", {
                          name: item.name,
                        })}
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
          title={t("library.mcp.emptyTitle")}
          action={
            <Button size="sm" onClick={() => setEditing({ item: undefined })}>
              <Plus />
              {t("library.mcp.add")}
            </Button>
          }
        >
          {t("library.mcp.emptyBody")}
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
        title={t("library.mcp.deleteTitle", { name: removing?.name ?? "" })}
        description={t("library.mcp.deleteBody")}
        action={t("library.delete")}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await modelPlane().library.mcp.remove(removing.name);
          notify.success(t("library.mcp.deleted", { name: removing.name }));
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
  // The name of a skill the Library already has, while replacing it is asked.
  const [replacing, setReplacing] = useState<string | null>(null);
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
      t("library.skill.fromFolder", { name: top }),
      async () => {
        // Checked before reading, so a large folder is never loaded.
        const size = files.reduce((sum, file) => sum + file.size, 0);
        if (files.length > SKILL_LIMITS.files)
          throw new Error(
            t("library.skill.folderTooMany", {
              count: files.length,
              limit: SKILL_LIMITS.files,
            }),
          );
        if (size > SKILL_LIMITS.bytes)
          throw new Error(
            t("library.skill.folderTooLarge", { size: bytes(size) }),
          );
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
      t("library.skill.fromZip", { name: file.name }),
      async () => readZip(await file.arrayBuffer()),
      file.name.replace(/\.zip$/i, ""),
    );
  };
  const done = (skill: LibrarySkill, uploaded: boolean) => {
    setBusy(false);
    notify.success(
      t(uploaded ? "library.skill.uploaded" : "library.skill.imported", {
        name: skill.name,
        count: skill.files,
      }),
    );
    onSaved();
    onClose();
  };
  /** Uploads or imports; only `replace` replaces a skill of the same name. */
  const send = (replace: boolean): Promise<void> => {
    const skills = modelPlane().library.skills;
    return mode === "upload" && picked.state === "ready"
      ? skills
          .upload({
            ...uploadInput(name.trim(), picked.files, agents),
            ...(replace ? { replace: true } : {}),
          })
          .then((skill) => done(skill, true))
      : skills
          .import(source.trim(), agents, { replace })
          .then((skill) => done(skill, false));
  };
  const save = () => {
    setBusy(true);
    setFailure(null);
    send(false).catch((reason: unknown) => {
      setBusy(false);
      const problem = failureOf(reason);
      // The daemon replaces a skill only when asked to; ask first.
      if (problem.code === "LIBRARY_EXISTS")
        setReplacing(
          mode === "upload"
            ? name.trim()
            : (source.trim().split(/[\\/]/).filter(Boolean).at(-1) ??
                source.trim()),
        );
      else setFailure(problem);
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
          <DialogTitle>{t("library.skill.add")}</DialogTitle>
          <DialogDescription>
            {t("library.skill.description")}
          </DialogDescription>
        </DialogHeader>
        <div
          className="segmented"
          role="tablist"
          aria-label={t("library.skill.source")}
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "upload"}
            disabled={busy}
            onClick={() => setMode("upload")}
          >
            {t("library.skill.uploadTab")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "path"}
            disabled={busy}
            onClick={() => setMode("path")}
          >
            {t("library.skill.pathTab")}
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
              aria-label={t("library.skill.pickFolderLabel")}
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
              aria-label={t("library.skill.pickZipLabel")}
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
                {t("library.skill.pickFolder")}
              </Button>
              <Button
                variant="outline"
                disabled={busy || picked.state === "reading"}
                onClick={() => zipInput.current?.click()}
              >
                <FileArchive />
                {t("library.skill.pickZip")}
              </Button>
            </div>
            {picked.state === "reading" ? (
              <p
                className="flex items-center gap-2 text-[13px] text-muted-foreground"
                role="status"
              >
                <Loader2 className="size-4 animate-spin" />
                {t("library.skill.reading")}
              </p>
            ) : picked.state === "error" ? (
              <p role="alert" className="callout error">
                {picked.message}
              </p>
            ) : picked.state === "ready" ? (
              <div className="space-y-2 rounded-xl border p-3">
                <p className="text-[13px]">
                  {t("library.skill.summary", {
                    from: picked.from,
                    count: picked.files.length,
                    size: bytes(picked.size),
                  })}
                  {picked.files.some((file) => file.exec)
                    ? t("library.skill.executableCount", {
                        count: picked.files.filter((file) => file.exec).length,
                      })
                    : ""}
                </p>
                <label className="field-label">
                  {t("library.name")}
                  <input
                    className="field font-mono text-[13px]"
                    value={name}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <span className="field-hint block">
                    {t("library.skill.nameHint")}
                  </span>
                </label>
                <ul className="max-h-[22vh] overflow-y-auto font-mono text-[12px] text-muted-foreground">
                  {picked.files.slice(0, 50).map((file) => (
                    <li key={file.path} className="truncate">
                      {file.path}
                      {file.exec ? (
                        <span className="ml-1.5 text-subtle">
                          {t("library.skill.executable")}
                        </span>
                      ) : null}
                    </li>
                  ))}
                  {picked.files.length > 50 ? (
                    <li>
                      {t("library.skill.more", {
                        count: picked.files.length - 50,
                      })}
                    </li>
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
                {t("library.skill.uploadHint")}
              </p>
            )}
          </div>
        ) : (
          <label className="field-label">
            {t("library.skill.path")}
            <input
              className="field font-mono text-[13px]"
              value={source}
              autoComplete="off"
              spellCheck={false}
              placeholder="/Users/me/skills/pdf-tools"
              onChange={(event) => setSource(event.target.value)}
            />
            <span className="field-hint block">
              {t("library.skill.pathHint")}
            </span>
          </label>
        )}
        <AgentChooser value={agents} onChange={setAgents} names={names} />
        <ErrorCallout failure={failure} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy || !ready} onClick={save}>
            {busy ? <Loader2 className="animate-spin" /> : <FolderInput />}
            {mode === "upload"
              ? t("library.skill.upload")
              : t("library.skill.importAction")}
          </Button>
        </DialogFooter>
        <ConfirmDialog
          open={replacing !== null}
          title={t("library.skill.replaceTitle", { name: replacing ?? "" })}
          description={t("library.skill.replaceBody", {
            name: replacing ?? "",
          })}
          action={t("library.skill.replace")}
          onClose={() => setReplacing(null)}
          onConfirm={() => send(true)}
        />
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
          <DialogTitle>
            {t("library.skill.agentsTitle", { name: skill.name })}
          </DialogTitle>
          <DialogDescription>{skill.description}</DialogDescription>
        </DialogHeader>
        <AgentChooser value={agents} onChange={setAgents} names={names} />
        <ErrorCallout failure={failure} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
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
                    notify.success(
                      t("library.skill.agentsUpdated", { name: skill.name }),
                    );
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
            {t("library.save")}
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
          {t("library.skill.add")}
        </Button>
      </div>
      {data.skills.length ? (
        <div className="panel overflow-x-auto">
          <table className="data-table min-w-[720px]">
            <thead>
              <tr>
                <th>Skill</th>
                <th>{t("library.skill.files")}</th>
                <th>Agent</th>
                <th>{t("library.modified")}</th>
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
                    {t("library.skill.fileCount", {
                      count: skill.files,
                      size: bytes(skill.size),
                    })}
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
                      aria-label={t("library.skill.agentsLabel", {
                        name: skill.name,
                      })}
                      onClick={() => setAssigning(skill)}
                    >
                      <Users />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("library.deleteItem", { name: skill.name })}
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
          title={t("library.skill.emptyTitle")}
          action={
            <Button size="sm" onClick={() => setImporting(true)}>
              <FolderInput />
              {t("library.skill.add")}
            </Button>
          }
        >
          {t("library.skill.emptyBody")}
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
        title={t("library.skill.deleteTitle", { name: removing?.name ?? "" })}
        description={t("library.skill.deleteBody")}
        action={t("library.delete")}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await modelPlane().library.skills.remove(removing.name);
          notify.success(t("library.skill.deleted", { name: removing.name }));
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
  const tab: Tab = tabs.some((item) => item === requested)
    ? (requested as Tab)
    : "instructions";
  const names = namesOf(data.state === "ready" ? data.value.agents : []);
  return (
    <div className="page-body">
      <div className="page-column max-w-[1040px]">
        <PageHeader title="Library" lede={t("library.lede")}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("common.refresh")}
            onClick={reload}
          >
            <RefreshCw />
          </Button>
        </PageHeader>
        <div className="mt-5">
          <div className="segmented" role="tablist" aria-label="Library">
            {tabs.map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={item === tab}
                onClick={() =>
                  navigate("library", {
                    search: item === "instructions" ? "" : `?tab=${item}`,
                    replace: true,
                  })
                }
              >
                {t(`library.tab.${item}`)}
                {data.state === "ready" && item !== "sync" ? (
                  <span className="ml-1 text-subtle">
                    {data.value[item].length}
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
              aria-label={t("common.loading")}
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
                {t("library.syncIntro")}
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
