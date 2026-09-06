"use client";
import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import {
  configurationSchema,
  type Configuration,
} from "@/lib/engine-configuration";
import {
  type Candidate,
  type Engine,
  type Registration,
} from "@/lib/contracts";
const field =
  "mt-1.5 w-full rounded-md border bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#8fa77b]";
const label = "block text-xs font-medium";
const protocols: Record<string, string> = {
  "openai-completions": "OpenAI 兼容 · Chat Completions",
  "openai-responses": "OpenAI 兼容 · Responses",
  anthropic: "Anthropic",
  google: "Google Gemini",
};
type Tab = "连接" | "Skills" | "MCP" | "高级";
/** Each editor works on a complete revision; unknown/unsupported settings fail through the same Gateway schema. */
export function EngineConfigurationDialog({
  engine,
  onClose,
  onSaved,
}: {
  engine: Engine;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const initial = engine.configuration;
  const [tab, setTab] = useState<Tab>("连接");
  const [model, setModel] = useState(engine.model ?? "");
  const [adapter, setAdapter] = useState<Configuration["adapter"]>(
    initial?.adapter ??
      ([
        "codex",
        "claude",
        "opencode",
        "mimo",
        "hermes",
        "pi",
        "gemini",
        "qwen",
        "cursor",
        "copilot",
        "kimi",
        "kiro",
        "qoder",
        "dsh",
        "openclaw",
        "antigravity",
      ].includes(engine.id)
        ? (engine.id as Configuration["adapter"])
        : "generic"),
  );
  const [provider, setProvider] = useState(initial?.provider?.protocol ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.provider?.baseUrl ?? "");
  const [secretKind, setSecretKind] = useState<
    "new" | "env" | "file" | "keychain"
  >(initial?.provider?.apiKey?.kind ?? "new");
  const [secretValue, setSecretValue] = useState(
    initial?.provider?.apiKey?.value ?? "",
  );
  const [newKey, setNewKey] = useState("");
  const [skills, setSkills] = useState(initial?.skills ?? []);
  const [mcpText, setMcpText] = useState(
    JSON.stringify(initial?.mcpServers ?? [], null, 2),
  );
  const [envText, setEnvText] = useState(
    JSON.stringify(initial?.env ?? {}, null, 2),
  );
  const [secretEnvText, setSecretEnvText] = useState(
    JSON.stringify(initial?.secretEnv ?? {}, null, 2),
  );
  const [templates, setTemplates] = useState<Candidate[]>([]);
  const [adapters, setAdapters] = useState<
    {
      id: Configuration["adapter"];
      providerProtocols: string[];
      description: string;
    }[]
  >([]);
  const [useTemplate, setUseTemplate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api.configurationAdapters(controller.signal),
      api.configurationTemplates(controller.signal),
    ])
      .then(([a, t]) => {
        if (!controller.signal.aborted) {
          setAdapters(a.adapters);
          setTemplates(t.candidates);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "无法读取适配能力");
      });
    return () => controller.abort();
  }, []);
  const selected = adapters.find((a) => a.id === adapter);
  const template = templates.find((t) => t.id === adapter)?.registration;
  function change() {
    setSaved(false);
    setError(null);
  }
  function registration(config: Configuration): Registration {
    if (!engine.command || engine.driver === "fake")
      throw new Error("不支持配置该引擎");
    const launch = useTemplate ? template : undefined;
    if (useTemplate && !launch)
      throw new Error("本机没有此适配器的标准启动模板");
    return {
      id: engine.id,
      driver: launch?.driver ?? engine.driver,
      command: launch?.command ?? engine.command,
      enabled: engine.enabled,
      maxConcurrency: engine.maxConcurrency,
      ...(engine.credentialEnv ? { credentialEnv: engine.credentialEnv } : {}),
      ...(engine.cli && !launch ? { cli: engine.cli } : {}),
      ...(launch?.cli ? { cli: launch.cli } : {}),
      ...(engine.acp ? { acp: engine.acp } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      configuration: config,
    };
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const raw: unknown = {
        adapter,
        ...(provider
          ? {
              provider: {
                protocol: provider,
                ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
                ...(secretKind !== "new" && secretValue.trim()
                  ? { apiKey: { kind: secretKind, value: secretValue.trim() } }
                  : {}),
              },
            }
          : {}),
        skills: skills.map(({ sha256: _hash, ...skill }) => skill),
        mcpServers: JSON.parse(mcpText) as unknown,
        env: JSON.parse(envText) as unknown,
        secretEnv: JSON.parse(secretEnvText) as unknown,
      };
      let config = configurationSchema.parse(raw);
      let body = registration(config);
      // Validate and pin local skill content before allocating a new immutable credential.
      const inspected = await api.inspectConfiguration(body);
      if (inspected.configuration)
        config = configurationSchema.parse(inspected.configuration);
      if (provider && secretKind === "new" && newKey) {
        const { reference } = await api.createSecret(newKey);
        setSecretKind(reference.kind);
        setSecretValue(reference.value);
        setNewKey("");
        config = {
          ...config,
          provider: { ...config.provider!, apiKey: reference },
        };
      }
      body = registration(config);
      await api.replace(body);
      setSkills(config.skills ?? []);
      await onSaved();
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[700px]">
        <DialogHeader>
          <DialogTitle>引擎配置 · {engine.id}</DialogTitle>
          <DialogDescription>
            保存为新版本，只影响新会话。密钥不写入引擎配置或任务记录。
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 border-b pb-3">
          {(["连接", "Skills", "MCP", "高级"] as const).map((name) => (
            <Button
              key={name}
              variant={tab === name ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={tab === name}
              onClick={() => setTab(name)}
            >
              {name}
            </Button>
          ))}
        </div>
        {tab === "连接" ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className={label}>
                配置适配器
                <select
                  aria-label="配置适配器"
                  className={field}
                  value={adapter}
                  onChange={(e) => {
                    setAdapter(e.target.value as Configuration["adapter"]);
                    setProvider("");
                    setUseTemplate(false);
                    change();
                  }}
                >
                  {adapters.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className={label}>
                模型
                <input
                  className={field}
                  placeholder="留空沿用原生默认模型"
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    change();
                  }}
                />
              </label>
            </div>
            <label className={label}>
              Provider
              <select
                className={field}
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value as typeof provider);
                  change();
                }}
              >
                <option value="">沿用原生账号与配置</option>
                {selected?.providerProtocols.map((p) => (
                  <option key={p} value={p}>
                    {protocols[p] ?? p}
                  </option>
                ))}
              </select>
            </label>
            {selected && !selected.providerProtocols.length ? (
              <p className="text-xs leading-6 text-muted-foreground">
                此引擎的自定义 Provider
                尚未适配；可保留原生登录，或在高级配置中设置它支持的环境变量与密钥引用。
              </p>
            ) : null}
            {provider ? (
              <>
                <label className={label}>
                  API URL
                  <input
                    className={field}
                    placeholder="https://api.example.com/v1"
                    value={baseUrl}
                    onChange={(e) => {
                      setBaseUrl(e.target.value);
                      change();
                    }}
                  />
                </label>
                <div className="rounded-lg border p-4">
                  <label className={label}>
                    API Key 来源
                    <select
                      className={field}
                      value={secretKind}
                      onChange={(e) => {
                        setSecretKind(e.target.value as typeof secretKind);
                        setSecretValue("");
                        change();
                      }}
                    >
                      <option value="new">
                        输入新 Key · 保存到系统安全存储
                      </option>
                      <option value="env">环境变量引用</option>
                      <option value="file">本地密钥文件引用</option>
                      {secretKind === "keychain" ? (
                        <option value="keychain">已保存的安全存储引用</option>
                      ) : null}
                    </select>
                  </label>
                  <label className={`${label} mt-3`}>
                    {secretKind === "new"
                      ? "API Key"
                      : secretKind === "env"
                        ? "环境变量名称"
                        : secretKind === "file"
                          ? "密钥文件绝对路径"
                          : "安全存储引用 ID"}
                    <input
                      type={secretKind === "new" ? "password" : "text"}
                      autoComplete="off"
                      className={field}
                      value={secretKind === "new" ? newKey : secretValue}
                      onChange={(e) => {
                        if (secretKind === "new") setNewKey(e.target.value);
                        else setSecretValue(e.target.value);
                        change();
                      }}
                      placeholder={
                        secretKind === "new"
                          ? "留空表示无新密钥"
                          : secretKind === "env"
                            ? "MY_ENGINE_API_KEY"
                            : secretKind === "file"
                              ? "/absolute/path/to/key"
                              : ""
                      }
                    />
                  </label>
                  <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                    新密钥只在保存时提交，之后仅返回引用。文件引用需为仅当前用户可读的普通文件。
                  </p>
                </div>
              </>
            ) : null}
            <label className="flex items-start gap-2 rounded-lg border p-3 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                disabled={!template}
                checked={useTemplate}
                onChange={(e) => {
                  setUseTemplate(e.target.checked);
                  change();
                }}
              />
              <span>
                使用本机标准启动模板{!template ? "（未找到）" : ""}
                <span className="mt-1 block text-muted-foreground">
                  替换此版本的启动命令。用于切换掉固定 Provider 的旧自定义脚本。
                </span>
              </span>
            </label>
            {useTemplate ? (
              <pre className="max-h-32 overflow-auto rounded border bg-muted/30 p-3 text-[10px]">
                {JSON.stringify(template?.command, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : null}
        {tab === "Skills" ? (
          <div className="space-y-4">
            <p className="text-xs leading-6 text-muted-foreground">
              选择本地
              SKILL.md。启用的指令作为任务上下文发送给此引擎；保存时固定内容指纹，附件继续从原目录引用。再次保存可接受已审阅的新版指令。
            </p>
            {skills.map((skill, index) => (
              <div className="flex items-start gap-2" key={index}>
                <input
                  aria-label={`启用 Skill ${index + 1}`}
                  type="checkbox"
                  className="mt-4"
                  checked={skill.enabled}
                  onChange={(e) => {
                    setSkills(
                      skills.map((s, i) =>
                        i === index ? { ...s, enabled: e.target.checked } : s,
                      ),
                    );
                    change();
                  }}
                />
                <label className={`${label} min-w-0 flex-1`}>
                  SKILL.md 路径
                  <input
                    className={field}
                    value={skill.path}
                    placeholder="/absolute/path/to/skill/SKILL.md"
                    onChange={(e) => {
                      setSkills(
                        skills.map((s, i) =>
                          i === index ? { ...s, path: e.target.value } : s,
                        ),
                      );
                      change();
                    }}
                  />
                  {skill.sha256 ? (
                    <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
                      {skill.sha256.slice(0, 16)}
                    </span>
                  ) : null}
                </label>
                <Button
                  aria-label={`删除 Skill ${index + 1}`}
                  variant="ghost"
                  size="icon"
                  className="mt-5"
                  onClick={() => {
                    setSkills(skills.filter((_, i) => i !== index));
                    change();
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSkills([...skills, { path: "", enabled: true }]);
                change();
              }}
            >
              <Plus />
              添加 Skill
            </Button>
          </div>
        ) : null}
        {tab === "MCP" ? (
          <div className="space-y-3">
            <p className="text-xs leading-6 text-muted-foreground">
              ACP 引擎支持 stdio、HTTP 和 SSE。每项用 enabled 控制启停。凭证用
              secretEnv / secretHeaders 引用；通用 CLI 不接受 MCP 注入。
            </p>
            <label className={label}>
              MCP 服务配置（JSON）
              <Textarea
                className="mt-2 min-h-[250px] font-mono text-xs"
                spellCheck={false}
                value={mcpText}
                onChange={(e) => {
                  setMcpText(e.target.value);
                  change();
                }}
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                try {
                  const existing: unknown = JSON.parse(mcpText);
                  if (!Array.isArray(existing)) throw new Error();
                  setMcpText(
                    JSON.stringify(
                      [
                        ...existing,
                        {
                          name: "my-tools",
                          type: "stdio",
                          enabled: false,
                          command: "/absolute/path/to/mcp-server",
                          args: [],
                          secretEnv: {},
                        },
                      ],
                      null,
                      2,
                    ),
                  );
                  change();
                } catch {
                  setError("请先修正 MCP JSON 数组");
                }
              }}
            >
              <Plus />
              插入 stdio 示例
            </Button>
            <p className="text-[11px] text-muted-foreground">
              HTTP 示例：
              {`{"name":"remote","type":"http","enabled":true,"url":"https://example.com/mcp","secretHeaders":{"Authorization":{"kind":"env","value":"MCP_AUTHORIZATION"}}}`}
            </p>
          </div>
        ) : null}
        {tab === "高级" ? (
          <div className="space-y-4">
            <label className={label}>
              普通环境变量（JSON）
              <Textarea
                className="mt-2 min-h-24 font-mono text-xs"
                value={envText}
                onChange={(e) => {
                  setEnvText(e.target.value);
                  change();
                }}
              />
            </label>
            <label className={label}>
              环境密钥映射（JSON）
              <Textarea
                className="mt-2 min-h-32 font-mono text-xs"
                value={secretEnvText}
                onChange={(e) => {
                  setSecretEnvText(e.target.value);
                  change();
                }}
              />
            </label>
            <p className="text-[11px] leading-6 text-muted-foreground">
              示例：{`{"OPENAI_API_KEY":{"kind":"env","value":"ENGINE_A_KEY"}}`}
              。另一引擎可以把同一个目标变量映射到
              ENGINE_B_KEY。禁止通过普通变量传密钥或覆盖进程控制变量。
            </p>
          </div>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="rounded-md bg-destructive/5 p-3 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="text-xs text-[#52714a]">
            已保存新配置版本。现有会话继续使用原版本。
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            关闭
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? <Loader2 className="animate-spin" /> : null}保存配置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
