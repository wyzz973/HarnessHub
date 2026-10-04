// SPDX-License-Identifier: MIT
import { useCallback, useRef, useState } from "react";
import {
  CloudUpload,
  Download,
  FileUp,
  Loader2,
  Pencil,
  Power,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import type {
  Agent,
  BackupEnvelope,
  RestoreSummary,
  SyncStatus,
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
  backupFileName,
  libraryChanged,
  readBackupFile,
  restoreAgentActions,
  syncFormOf,
  syncPartNames,
  syncSettings,
  type SyncForm,
} from "@/lib/backup";
import { installedLibraryAgents } from "@/lib/library";
import { failureOf, modelPlane, type Failure } from "@/lib/model-plane";
import { navigate } from "@/lib/router";
import { notify } from "@/lib/toast";
import { LibrarySync } from "./library-sync";
import {
  Card,
  Checkbox,
  ConfirmDialog,
  ErrorCallout,
  LoadError,
  LocalTime,
  PageHeader,
  Row,
  useLoaded,
} from "./model-plane-ui";

/** The daemon reads at most 64 MiB of a restore request. */
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

function PassphraseFields({
  passphrase,
  confirm,
  onPassphrase,
  onConfirm,
  label = "口令",
  optional,
}: {
  passphrase: string;
  confirm: string;
  onPassphrase: (value: string) => void;
  onConfirm: (value: string) => void;
  label?: string;
  optional?: string;
}) {
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="field-label">
        {label}
        <input
          className="field"
          type="password"
          value={passphrase}
          autoComplete="new-password"
          placeholder={optional}
          onChange={(event) => onPassphrase(event.target.value)}
        />
      </label>
      <label className="field-label">
        再输入一次
        <input
          className="field"
          type="password"
          value={confirm}
          autoComplete="new-password"
          aria-invalid={mismatch}
          onChange={(event) => onConfirm(event.target.value)}
        />
        {mismatch ? (
          <span role="alert" className="field-hint block text-danger">
            两次输入的口令不一致
          </span>
        ) : null}
      </label>
    </div>
  );
}

/** Download a sealed backup; the passphrase is typed twice and dropped after. */
function BackupCard() {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [keys, setKeys] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const ready = passphrase.length > 0 && passphrase === confirm;
  const download = () => {
    setBusy(true);
    setFailure(null);
    modelPlane()
      .backup.create({ passphrase, keys })
      .then(
        (envelope) => {
          setBusy(false);
          setPassphrase("");
          setConfirm("");
          const url = URL.createObjectURL(
            new Blob([`${JSON.stringify(envelope)}\n`], {
              type: "application/json",
            }),
          );
          const link = document.createElement("a");
          link.href = url;
          link.download = backupFileName(new Date());
          document.body.append(link);
          link.click();
          link.remove();
          // Some browsers read the blob after the click returns.
          window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
          notify.success(`已下载备份 ${link.download}`);
        },
        (reason: unknown) => {
          setBusy(false);
          setFailure(failureOf(reason));
        },
      );
  };
  return (
    <Card
      title="备份"
      lede="把 provider、凭据、路由组、模型覆盖、Agent 接线、Profile 与 Library 打包成一个用口令加密的文件。"
    >
      <PassphraseFields
        passphrase={passphrase}
        confirm={confirm}
        onPassphrase={setPassphrase}
        onConfirm={setConfirm}
      />
      <Checkbox checked={keys} onChange={setKeys}>
        包含凭据的值（API Key 与 Library 的秘密）
      </Checkbox>
      <p className="field-hint">
        口令只用于这一次加密，页面与守护进程都不保存；忘记口令就无法打开这个文件。
        {keys
          ? "文件含有 Key 的值，请像保管 Key 一样保管它。"
          : "不含 Key 时，凭据只保留名称，恢复后需要重新填写 Key。"}
        Gateway Key 的文本、用量与会话不在备份中。
      </p>
      <ErrorCallout failure={failure} />
      <div className="flex justify-end">
        <Button disabled={busy || !ready} onClick={download}>
          {busy ? <Loader2 className="animate-spin" /> : <Download />}
          下载备份
        </Button>
      </div>
    </Card>
  );
}

function Names({ items, tone }: { items: string[]; tone?: string }) {
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {items.map((item) => (
        <span key={item} className={`tag ${tone ?? ""} font-mono`}>
          {item}
        </span>
      ))}
    </span>
  );
}

/** `新增 a b · 替换 c`, with nothing for empty parts. */
function Changes({
  parts,
}: {
  parts: Array<{ label: string; items: string[]; tone?: string }>;
}) {
  const shown = parts.filter((part) => part.items.length);
  if (!shown.length) return <span className="text-subtle">没有变化</span>;
  return (
    <span className="flex flex-col gap-1.5">
      {shown.map((part) => (
        <span key={part.label} className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12.5px] text-muted-foreground">
            {part.label}
          </span>
          <Names items={part.items} tone={part.tone} />
        </span>
      ))}
    </span>
  );
}

const shareActions: Record<RestoreSummary["gatewayShare"]["action"], string> = {
  apply: "应用备份中的局域网共享设置",
  unchanged: "与本机相同",
  absent: "备份中没有",
  unavailable: "无法应用",
};

/**
 * What a restore does (`done` false: the dry run) or did: records added and
 * replaced, what needs a key or a secret again, the agents re-wired and
 * the client keys to issue again.
 */
function RestoreSummaryView({
  summary,
  done,
  names,
}: {
  summary: RestoreSummary;
  done: boolean;
  names: ReadonlyMap<string, string>;
}) {
  const library = summary.library;
  return (
    <div className="space-y-3 rounded-xl border p-4">
      <p className="text-[13px]">
        备份生成于 <LocalTime value={summary.createdAt} />
        ，来自 <span className="font-mono">{summary.app}</span>；
        {summary.keys
          ? "带有凭据的值。"
          : "不带凭据的值：本机已有的 Key 保留，其余需要重新填写。"}
      </p>
      <dl className="text-[13px]">
        <Row label="Provider">
          <Changes
            parts={[
              { label: "新增", items: summary.providers.added },
              { label: "替换", items: summary.providers.replaced },
              {
                label: "需要填写 Key",
                items: summary.providers.needKey,
                tone: "warn",
              },
            ]}
          />
        </Row>
        <Row label="路由组">
          <Changes
            parts={[
              { label: "新增", items: summary.groups.added },
              { label: "替换", items: summary.groups.replaced },
              {
                label: "跳过（成员的 provider 不存在）",
                items: summary.groups.skipped,
                tone: "warn",
              },
            ]}
          />
        </Row>
        <Row label="模型覆盖">{summary.overrides} 条</Row>
        <Row label="Profile">
          <Changes
            parts={[
              { label: "新增", items: summary.profiles.added },
              { label: "替换", items: summary.profiles.replaced },
            ]}
          />
        </Row>
        <Row label="Library">
          {library ? (
            <Changes
              parts={[
                { label: "新增指令集", items: library.instructions.added },
                { label: "替换指令集", items: library.instructions.replaced },
                { label: "新增 MCP", items: library.mcp.added },
                { label: "替换 MCP", items: library.mcp.replaced },
                {
                  label: "缺少秘密、已去掉",
                  items: library.mcp.needSecret,
                  tone: "warn",
                },
                { label: "新增 Skill", items: library.skills.added },
                { label: "替换 Skill", items: library.skills.replaced },
                {
                  label: "缺少大文件",
                  items: library.skills.incomplete,
                  tone: "warn",
                },
                {
                  label: "被拒绝",
                  items: library.refused.map(
                    (item) => `${item.kind}:${item.name}`,
                  ),
                  tone: "error",
                },
              ]}
            />
          ) : (
            <span className="text-subtle">不带入</span>
          )}
        </Row>
        <Row label="局域网共享">
          {shareActions[summary.gatewayShare.action]}
          {summary.gatewayShare.error ? (
            <span className="block text-danger">
              {summary.gatewayShare.error}
            </span>
          ) : null}
        </Row>
        {summary.catalog?.differs ? (
          <Row label="模型目录">
            备份中的目录设置与本机不同；它来自配置文件，恢复不改。
          </Row>
        ) : null}
      </dl>
      {library?.refused.length ? (
        <ul className="callout error block list-disc space-y-0.5 pl-8">
          {library.refused.map((item) => (
            <li key={`${item.kind}:${item.name}`}>
              <span className="font-mono">
                {item.kind}:{item.name}
              </span>{" "}
              {item.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {summary.agents.length ? (
        <div className="overflow-x-auto rounded-xl border">
          <table className="data-table min-w-[560px]">
            <thead>
              <tr>
                <th>Agent</th>
                <th>模型</th>
                <th>{done ? "结果" : "将要"}</th>
              </tr>
            </thead>
            <tbody>
              {summary.agents.map((agent) => {
                const action = restoreAgentActions[agent.action];
                return (
                  <tr key={agent.agent}>
                    <td>{names.get(agent.agent) ?? agent.agent}</td>
                    <td className="font-mono text-[12.5px]">
                      {agent.model ?? "自行登录"}
                    </td>
                    <td>
                      {agent.outcome === "failed" ? (
                        <span className="tag error" title={agent.error}>
                          接线失败
                        </span>
                      ) : agent.outcome === "wired" ? (
                        <span className="tag good">已重新接线</span>
                      ) : (
                        <span className={`tag ${action.tone}`}>
                          {action.label}
                        </span>
                      )}
                      {agent.error ? (
                        <span className="mt-1 block text-[12px] text-danger">
                          {agent.error}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {summary.clientKeys.length ? (
        <div className="callout info items-center">
          <span className="min-w-0 flex-1">
            Key 的文本不在备份中，这些 client Key 需要重新签发：
            <Names items={summary.clientKeys.map((key) => key.name)} />
          </span>
          {done ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => navigate("keys")}
            >
              去签发
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type RestorePhase =
  | { step: "idle" }
  | { step: "busy"; dryRun: boolean }
  | { step: "preview"; summary: RestoreSummary }
  | { step: "done"; summary: RestoreSummary };

/**
 * Restore a backup file: preview first (`dryRun`), then restore exactly
 * with the same choices. A restore that brought Library items in offers
 * to sync them into the agents installed here.
 */
function RestoreCard() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{
    name: string;
    envelope: BackupEnvelope;
  } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [agents, setAgents] = useState(true);
  const [library, setLibrary] = useState(true);
  const [phase, setPhase] = useState<RestorePhase>({ step: "idle" });
  const [failure, setFailure] = useState<Failure | null>(null);
  const [agentList, setAgentList] = useState<Agent[] | null>(null);
  const reset = () => {
    setPhase({ step: "idle" });
    setFailure(null);
  };
  const choose = (chosen: File | undefined) => {
    reset();
    setFile(null);
    setFileError(null);
    if (!chosen) return;
    if (chosen.size > MAX_BACKUP_BYTES) {
      setFileError("文件超过 64 MiB，不是 HarnessHub 备份");
      return;
    }
    chosen.text().then(
      (text) => {
        try {
          setFile({ name: chosen.name, envelope: readBackupFile(text) });
        } catch (error) {
          setFileError(error instanceof Error ? error.message : String(error));
        }
      },
      () => setFileError("读取文件失败"),
    );
  };
  const run = (dryRun: boolean) => {
    if (!file) return;
    setPhase({ step: "busy", dryRun });
    setFailure(null);
    const client = modelPlane();
    client.backup
      .restore({
        backup: file.envelope,
        passphrase,
        agents,
        library,
        dryRun,
      })
      .then(
        async (summary) => {
          // Names, and the agents a Library sync goes to.
          setAgentList(
            await client.agents.list().then(
              (page) => page.items,
              () => [],
            ),
          );
          if (dryRun) {
            setPhase({ step: "preview", summary });
            return;
          }
          setPassphrase("");
          setPhase({ step: "done", summary });
          notify.success("已恢复");
        },
        (reason: unknown) => {
          setPhase({ step: "idle" });
          setFailure(failureOf(reason));
        },
      );
  };
  const busy = phase.step === "busy";
  const names = new Map(
    (agentList ?? []).map((agent) => [agent.id, agent.name]),
  );
  const syncTo = agentList ? installedLibraryAgents(agentList) : [];
  return (
    <Card
      title="恢复"
      lede="从备份文件恢复：同名的记录被替换，其余新增，本机的其他记录不删除。先预览，确认后再恢复。"
    >
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={fileInput}
          type="file"
          accept=".harnesshub-backup,.json,application/json"
          className="sr-only"
          aria-label="选择备份文件"
          onChange={(event) => choose(event.target.files?.[0])}
        />
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          <FileUp />
          选择备份文件
        </Button>
        <span className="min-w-0 truncate font-mono text-[12.5px] text-muted-foreground">
          {file ? file.name : "尚未选择"}
        </span>
      </div>
      {fileError ? (
        <p role="alert" className="callout error">
          {fileError}
        </p>
      ) : null}
      <label className="field-label">
        口令
        <input
          className="field"
          type="password"
          value={passphrase}
          autoComplete="off"
          onChange={(event) => {
            setPassphrase(event.target.value);
            if (phase.step === "preview") reset();
          }}
        />
      </label>
      <div className="grid gap-x-2 sm:grid-cols-2">
        <Checkbox
          checked={agents}
          disabled={busy}
          onChange={(checked) => {
            setAgents(checked);
            if (phase.step === "preview") reset();
          }}
        >
          重新接线本机已安装的 Agent
        </Checkbox>
        <Checkbox
          checked={library}
          disabled={busy}
          onChange={(checked) => {
            setLibrary(checked);
            if (phase.step === "preview") reset();
          }}
        >
          带入 Library（指令集、MCP 服务与 Skills）
        </Checkbox>
      </div>
      <ErrorCallout failure={failure} />
      {phase.step === "preview" ? (
        <>
          <RestoreSummaryView
            summary={phase.summary}
            done={false}
            names={names}
          />
          {phase.summary.library ? (
            <p className="text-[12.5px] text-muted-foreground">
              恢复只把 Library 的条目带入
              HarnessHub；恢复之后会预览把它们写入本机 Agent
              的改动，再由你确认。
            </p>
          ) : null}
        </>
      ) : null}
      {phase.step === "done" ? (
        <RestoreSummaryView summary={phase.summary} done names={names} />
      ) : null}
      {phase.step === "done" && libraryChanged(phase.summary) && agentList ? (
        <section className="space-y-3 rounded-xl border p-4">
          <h3 className="section-title">把恢复的 Library 写入 Agent</h3>
          {syncTo.length ? (
            <LibrarySync agents={agentList} initial={syncTo} />
          ) : (
            <p className="text-[13px] text-muted-foreground">
              本机没有安装 Library 支持的 Agent；安装后在 Library 页同步。
            </p>
          )}
        </section>
      ) : null}
      {phase.step !== "done" ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            disabled={busy || !file || !passphrase}
            onClick={() => run(true)}
          >
            {busy && phase.dryRun ? <Loader2 className="animate-spin" /> : null}
            预览恢复
          </Button>
          <Button
            disabled={busy || phase.step !== "preview"}
            onClick={() => run(false)}
          >
            {busy && !phase.dryRun ? (
              <Loader2 className="animate-spin" />
            ) : null}
            恢复
          </Button>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button
            variant="outline"
            onClick={() => {
              setFile(null);
              if (fileInput.current) fileInput.current.value = "";
              setAgentList(null);
              reset();
            }}
          >
            完成
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Turn sync on or change it; saving syncs once, as `hh sync … on` does. */
function SyncDialog({
  status,
  onClose,
  onStatus,
}: {
  status: SyncStatus;
  onClose: () => void;
  onStatus: (status: SyncStatus) => void;
}) {
  const [form, setForm] = useState<SyncForm>(() => syncFormOf(status));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof SyncForm>(key: K, value: SyncForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  // Another kind is another target: its address and credentials start empty.
  const switchKind = (kind: SyncForm["kind"]) =>
    setForm((current) => ({
      ...syncFormOf(kind === status.kind ? status : undefined),
      kind,
      passphrase: current.passphrase,
      confirm: current.confirm,
      keys: current.keys,
      agents: current.agents,
    }));
  const s3 = form.kind === "s3";
  const save = () => {
    const result = syncSettings(
      form,
      saved ? { ...status, enabled: true } : status,
    );
    if ("error" in result) {
      setFailure({ message: result.error, fields: {}, references: [] });
      return;
    }
    setBusy(true);
    setFailure(null);
    const client = modelPlane();
    client.sync.configure(result.settings).then(
      (configured) => {
        // The secrets were sent once; the daemon keeps them from now on.
        setForm((current) => ({
          ...current,
          secret: "",
          passphrase: "",
          confirm: "",
        }));
        setSaved(true);
        onStatus(configured);
        client.sync.now().then(
          (synced) => {
            setBusy(false);
            onStatus(synced);
            notify.success("同步已开启，第一次同步已完成");
            onClose();
          },
          (reason: unknown) => {
            setBusy(false);
            const problem = failureOf(reason);
            setFailure({
              ...problem,
              message: `设置已保存，但第一次同步失败：${problem.message}`,
            });
          },
        );
      },
      (reason: unknown) => {
        setBusy(false);
        setFailure(failureOf(reason));
      },
    );
  };
  const enabled = status.enabled || saved;
  // The daemon keeps the stored secret only while the target is the same.
  const sameTarget =
    status.enabled &&
    form.kind === status.kind &&
    form.url.trim() === status.url;
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : null)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{status.enabled ? "修改同步" : "开启同步"}</DialogTitle>
          <DialogDescription>
            经 WebDAV 目录或 S3
            兼容存储桶在多台电脑之间同步。服务器只保存用口令加密的副本；每台电脑使用同一个口令。
          </DialogDescription>
        </DialogHeader>
        <div className="segmented" role="tablist" aria-label="同步方式">
          {(["webdav", "s3"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={form.kind === kind}
              disabled={busy}
              onClick={() => switchKind(kind)}
            >
              {kind === "webdav" ? "WebDAV" : "S3 兼容存储"}
            </button>
          ))}
        </div>
        <label className="field-label">
          {s3 ? "存储桶" : "WebDAV 目录"}
          <input
            className="field font-mono text-[13px]"
            value={form.url}
            autoComplete="off"
            spellCheck={false}
            placeholder={
              s3
                ? "s3://bucket/prefix"
                : "https://dav.example.com/remote.php/dav/files/me"
            }
            onChange={(event) => set("url", event.target.value)}
          />
          <span className="field-hint block">
            副本保存在其中的 harnesshub/harnesshub.harnesshub-backup。
          </span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="field-label">
            {s3 ? "Access Key ID" : "用户名"}
            <input
              className="field font-mono text-[13px]"
              value={form.user}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set("user", event.target.value)}
            />
          </label>
          <label className="field-label">
            {s3 ? "Secret Access Key" : "密码"}
            <input
              className="field font-mono text-[13px]"
              type="password"
              value={form.secret}
              autoComplete="new-password"
              placeholder={sameTarget ? "留空保留已保存的" : undefined}
              onChange={(event) => set("secret", event.target.value)}
            />
          </label>
        </div>
        {s3 ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="field-label sm:col-span-3">
              Endpoint
              <input
                className="field font-mono text-[13px]"
                value={form.endpoint}
                autoComplete="off"
                spellCheck={false}
                placeholder="缺省为 AWS 该区域的地址"
                onChange={(event) => set("endpoint", event.target.value)}
              />
            </label>
            <label className="field-label">
              区域
              <input
                className="field font-mono text-[13px]"
                value={form.region}
                autoComplete="off"
                spellCheck={false}
                placeholder="us-east-1"
                onChange={(event) => set("region", event.target.value)}
              />
            </label>
            <label className="field-label sm:col-span-2">
              地址形式
              <select
                className="field"
                value={form.pathStyle}
                onChange={(event) =>
                  set("pathStyle", event.target.value as SyncForm["pathStyle"])
                }
              >
                <option value="auto">自动</option>
                <option value="yes">路径式（endpoint/bucket）</option>
                <option value="no">虚拟主机式（bucket.endpoint）</option>
              </select>
            </label>
          </div>
        ) : null}
        <PassphraseFields
          passphrase={form.passphrase}
          confirm={form.confirm}
          onPassphrase={(value) => set("passphrase", value)}
          onConfirm={(value) => set("confirm", value)}
          optional={enabled ? "留空保留已保存的" : undefined}
        />
        <p className="callout warn">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            为了无人值守地同步，口令与目标的密码保存在本机的秘密存储中：能读取这个账户秘密的人也能打开服务器上的副本。
          </span>
        </p>
        <div className="grid gap-x-2 sm:grid-cols-2">
          <Checkbox
            checked={form.keys}
            onChange={(value) => set("keys", value)}
          >
            同步凭据的值（加密后上传）
          </Checkbox>
          <Checkbox
            checked={form.agents}
            onChange={(value) => set("agents", value)}
          >
            同步 Agent 接线
          </Checkbox>
        </div>
        <ErrorCallout failure={failure} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {saved ? "关闭" : "取消"}
          </Button>
          <Button disabled={busy} onClick={save}>
            {busy ? <Loader2 className="animate-spin" /> : <CloudUpload />}
            保存并同步
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SyncCard({
  status,
  onStatus,
}: {
  status: SyncStatus;
  onStatus: (status: SyncStatus) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const syncNow = () => {
    setSyncing(true);
    const client = modelPlane();
    client.sync.now().then(
      (synced) => {
        setSyncing(false);
        onStatus(synced);
        notify.success("已同步");
      },
      (reason: unknown) => {
        setSyncing(false);
        notify.error(reason, "同步失败");
        void client.sync.status().then(onStatus, () => undefined);
      },
    );
  };
  const notice = status.notice;
  return (
    <Card
      title="同步"
      lede="经 WebDAV 或 S3 兼容存储在多台电脑之间自动同步 provider、Agent 接线、Profile 与 Library；两边都改的部分保留最后修改的一边，另一边的副本存在本机。"
      aside={
        status.enabled ? (
          <span className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={syncing}
              onClick={syncNow}
            >
              {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              立即同步
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              <Pencil />
              修改
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDisabling(true)}
            >
              <Power />
              关闭
            </Button>
          </span>
        ) : (
          <Button size="sm" onClick={() => setEditing(true)}>
            <CloudUpload />
            开启同步
          </Button>
        )
      }
    >
      {status.enabled ? (
        <>
          <dl className="text-[13px]">
            <Row label="目标">
              <span className="tag">
                {status.kind === "s3" ? "S3" : "WebDAV"}
              </span>{" "}
              <span className="font-mono text-[12.5px] break-all">
                {status.url}
              </span>
            </Row>
            {status.user ? (
              <Row label={status.kind === "s3" ? "Access Key ID" : "用户名"}>
                <span className="font-mono text-[12.5px]">{status.user}</span>
              </Row>
            ) : null}
            {status.kind === "s3" && (status.endpoint || status.region) ? (
              <Row label="Endpoint">
                <span className="font-mono text-[12.5px] break-all">
                  {status.endpoint ?? "AWS"}
                  {status.region ? ` · ${status.region}` : ""}
                  {status.pathStyle !== undefined
                    ? ` · ${status.pathStyle ? "路径式" : "虚拟主机式"}`
                    : ""}
                </span>
              </Row>
            ) : null}
            <Row label="内容">
              provider 与路由、Profile、Library
              {status.agents ? "、Agent 接线" : "（不含 Agent 接线）"}；
              {status.keys ? "带凭据的值" : "不带凭据的值"}
            </Row>
            <Row label="上次同步">
              <LocalTime value={status.lastSyncAt} />
            </Row>
            <Row label="下次同步">
              <LocalTime value={status.nextSyncAt} />
            </Row>
          </dl>
          {status.lastError ? (
            <p role="alert" className="callout error">
              最近一次同步失败：{status.lastError}
            </p>
          ) : null}
          {notice &&
          (notice.here.length || notice.there.length || notice.kept?.length) ? (
            <div className="callout warn block space-y-1">
              <p>
                <LocalTime value={notice.at} /> 的同步中两边都有改动：
              </p>
              <ul className="list-disc pl-5">
                {notice.here.length ? (
                  <li>
                    本机的
                    {notice.here.map((part) => syncPartNames[part]).join("、")}
                    被服务器的版本替换
                  </li>
                ) : null}
                {notice.there.length ? (
                  <li>
                    服务器的
                    {notice.there.map((part) => syncPartNames[part]).join("、")}
                    被本机的版本替换
                  </li>
                ) : null}
                {notice.kept?.length ? (
                  <li>
                    服务器上已删除、但仍被 Gateway Key 使用而保留：
                    <span className="font-mono">{notice.kept.join("、")}</span>
                  </li>
                ) : null}
              </ul>
              {notice.saved ? (
                <p>
                  被替换的副本（加密）保存在{" "}
                  <span className="font-mono break-all">{notice.saved}</span>
                </p>
              ) : null}
            </div>
          ) : null}
          {status.warnings?.length ? (
            <ul className="callout warn block list-disc pl-8">
              {status.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          同步未开启。局域网共享、目录设置、client Key 与用量不参与同步。
        </p>
      )}
      {editing ? (
        <SyncDialog
          status={status}
          onClose={() => setEditing(false)}
          onStatus={onStatus}
        />
      ) : null}
      <ConfirmDialog
        open={disabling}
        title="关闭同步"
        description="删除同步设置、状态、服务器副本的本机缓存以及保存的密码与口令。冲突副本与服务器上的文件保留。"
        action="关闭同步"
        onClose={() => setDisabling(false)}
        onConfirm={async () => {
          onStatus(await modelPlane().sync.disable());
          notify.success("同步已关闭");
        }}
      />
    </Card>
  );
}

/** Backup, restore and sync (docs/backup-sync.md), the second tab of the settings. */
export function BackupPage({ tabs }: { tabs: React.ReactNode }) {
  const load = useCallback(() => modelPlane().sync.status(), []);
  const [data, reload] = useLoaded(load);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  return (
    <div className="page-body">
      <div className="page-column max-w-[880px]">
        {tabs}
        <PageHeader
          title="备份与同步"
          lede="把模型平面的设置带到另一台电脑，或者在几台电脑之间保持一致。"
        >
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="刷新"
            onClick={() => {
              setStatus(null);
              reload();
            }}
          >
            <RefreshCw />
          </Button>
        </PageHeader>
        <div className="mt-6 space-y-4">
          <BackupCard />
          <RestoreCard />
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
          ) : (
            <SyncCard status={status ?? data.value} onStatus={setStatus} />
          )}
        </div>
      </div>
    </div>
  );
}
