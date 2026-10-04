// SPDX-License-Identifier: MIT
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
  type HarnessModelView,
  type Registration,
} from "@/lib/contracts";
import { pathExamples, useWindowsPaths } from "@/lib/platform";
import { engineName } from "@/lib/engines";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
const field = "field";
const label = "field-label";
/** A provider protocol's name; product names stay as they are, others show as sent. */
function protocolName(protocol: string): string {
  if (protocol === "openai-completions" || protocol === "openai-responses")
    return t(`tasks.engineConfig.protocol.${protocol}`);
  const names: Record<string, string> = {
    anthropic: "Anthropic",
    google: "Google Gemini",
  };
  return names[protocol] ?? protocol;
}
type Tab = "connection" | "skills" | "mcp" | "advanced";
function tabName(tab: Tab): string {
  return tab === "connection"
    ? t("tasks.engineConfig.tab.connection")
    : tab === "advanced"
      ? t("tasks.engineConfig.tab.advanced")
      : tab === "skills"
        ? "Skills"
        : "MCP";
}
/**
 * Each editor works on a complete revision; unknown/unsupported settings fail through the same
 * Gateway schema. With a configured unified model the Gateway overwrites model and provider on
 * every registration (ADR 0013), so those fields are shown read-only and saved unchanged.
 */
export function EngineConfigurationDialog({
  engine,
  unifiedModel,
  onClose,
  onSaved,
}: {
  engine: Engine;
  unifiedModel?: HarnessModelView;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const initial = engine.configuration;
  const managed = unifiedModel?.configured ? unifiedModel : undefined;
  const examples = pathExamples(useWindowsPaths());
  const [tab, setTab] = useState<Tab>("connection");
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
      .then(([a, found]) => {
        if (!controller.signal.aborted) {
          setAdapters(a.adapters);
          setTemplates(found.candidates);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error
              ? e.message
              : t("tasks.engineConfig.adaptersFailed"),
          );
      });
    return () => controller.abort();
  }, []);
  const selected = adapters.find((a) => a.id === adapter);
  const template = templates.find(
    (candidate) => candidate.id === adapter,
  )?.registration;
  function change() {
    setSaved(false);
    setError(null);
  }
  function registration(config: Configuration): Registration {
    if (!engine.command || engine.driver === "fake")
      throw new Error(t("tasks.engineConfig.notConfigurable"));
    const launch = useTemplate ? template : undefined;
    if (useTemplate && !launch)
      throw new Error(t("tasks.engineConfig.noTemplate"));
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
      ...(managed
        ? engine.model
          ? { model: engine.model }
          : {}
        : model.trim()
          ? { model: model.trim() }
          : {}),
      configuration: config,
    };
  }
  /** Provider fields this form does not edit (headers, limits, compatibility) survive a same-protocol save. */
  function providerConfiguration() {
    if (managed) return initial?.provider ? { provider: initial.provider } : {};
    if (!provider) return {};
    const previous = initial?.provider;
    let preserved: Record<string, unknown> = {};
    if (previous?.protocol === provider) {
      const {
        protocol: _protocol,
        baseUrl: _baseUrl,
        apiKey: _apiKey,
        ...rest
      } = previous;
      preserved = rest;
    }
    return {
      provider: {
        ...preserved,
        protocol: provider,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(secretKind !== "new" && secretValue.trim()
          ? { apiKey: { kind: secretKind, value: secretValue.trim() } }
          : {}),
      },
    };
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const raw: unknown = {
        adapter,
        ...providerConfiguration(),
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
      if (!managed && provider && secretKind === "new" && newKey) {
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
      setError(
        e instanceof Error ? e.message : t("tasks.engineConfig.saveFailed"),
      );
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>
            {t("tasks.engineConfig.title", { engine: engineName(engine.id) })}
          </DialogTitle>
          <DialogDescription>{t("tasks.engineConfig.lede")}</DialogDescription>
        </DialogHeader>
        <div
          className="segmented w-fit"
          role="tablist"
          aria-label={t("tasks.engineConfig.tabs")}
        >
          {(["connection", "skills", "mcp", "advanced"] as const).map(
            (name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={tab === name}
                onClick={() => setTab(name)}
              >
                {tabName(name)}
              </button>
            ),
          )}
        </div>
        {tab === "connection" ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className={label}>
                {t("tasks.engineConfig.adapter")}
                <select
                  aria-label={t("tasks.engineConfig.adapter")}
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
                {t("tasks.engineConfig.model")}
                <input
                  className={cn(
                    field,
                    managed && "bg-muted text-muted-foreground",
                  )}
                  placeholder={t("tasks.engineConfig.modelPlaceholder")}
                  value={
                    managed ? (engine.model ?? managed.model ?? "") : model
                  }
                  readOnly={!!managed}
                  aria-describedby={managed ? "managed-model-note" : undefined}
                  onChange={(e) => {
                    setModel(e.target.value);
                    change();
                  }}
                />
              </label>
            </div>
            {managed ? (
              <p id="managed-model-note" className="callout good">
                {t("tasks.engineConfig.managedModel", {
                  model: managed.model ?? t("tasks.engineConfig.notReported"),
                })}
              </p>
            ) : null}
            <label className={label}>
              Provider
              <select
                className={cn(
                  field,
                  managed && "bg-muted text-muted-foreground",
                )}
                value={managed ? (initial?.provider?.protocol ?? "") : provider}
                disabled={!!managed}
                onChange={(e) => {
                  setProvider(e.target.value as typeof provider);
                  change();
                }}
              >
                <option value="">
                  {managed
                    ? t("tasks.engineConfig.managedProvider")
                    : t("tasks.engineConfig.nativeProvider")}
                </option>
                {(managed
                  ? [initial?.provider?.protocol].filter(
                      (p): p is NonNullable<typeof p> => !!p,
                    )
                  : (selected?.providerProtocols ?? [])
                ).map((p) => (
                  <option key={p} value={p}>
                    {protocolName(p)}
                  </option>
                ))}
              </select>
            </label>
            {!managed && selected && !selected.providerProtocols.length ? (
              <p className="field-hint">
                {t("tasks.engineConfig.noProvider")}
              </p>
            ) : null}
            {provider && !managed ? (
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
                <div className="rounded-xl border p-4">
                  <label className={label}>
                    {t("tasks.engineConfig.keySource")}
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
                        {t("tasks.engineConfig.keyNew")}
                      </option>
                      <option value="env">
                        {t("tasks.engineConfig.keyEnv")}
                      </option>
                      <option value="file">
                        {t("tasks.engineConfig.keyFile")}
                      </option>
                      {secretKind === "keychain" ? (
                        <option value="keychain">
                          {t("tasks.engineConfig.keyKeychain")}
                        </option>
                      ) : null}
                    </select>
                  </label>
                  <label className={`${label} mt-3`}>
                    {secretKind === "new"
                      ? "API Key"
                      : secretKind === "env"
                        ? t("tasks.engineConfig.envName")
                        : secretKind === "file"
                          ? t("tasks.engineConfig.filePath")
                          : t("tasks.engineConfig.keychainId")}
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
                          ? t("tasks.engineConfig.noNewKey")
                          : secretKind === "env"
                            ? "MY_ENGINE_API_KEY"
                            : secretKind === "file"
                              ? examples.keyFile
                              : ""
                      }
                    />
                  </label>
                  <p className="field-hint">
                    {t("tasks.engineConfig.storedHint")}
                  </p>
                </div>
              </>
            ) : null}
            <label className="flex items-start gap-2.5 rounded-xl border p-3.5 text-[13px]">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-(--primary)"
                disabled={!template}
                checked={useTemplate}
                onChange={(e) => {
                  setUseTemplate(e.target.checked);
                  change();
                }}
              />
              <span>
                {template
                  ? t("tasks.engineConfig.useTemplate")
                  : t("tasks.engineConfig.useTemplateMissing")}
              </span>
            </label>
            {useTemplate ? (
              <pre className="max-h-32 overflow-auto rounded-xl bg-code p-3 text-[11.5px]">
                {JSON.stringify(template?.command, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : null}
        {tab === "skills" ? (
          <div className="space-y-4">
            <p className="field-hint mt-0">
              {t("tasks.engineConfig.skillsHint")}
            </p>
            {skills.map((skill, index) => (
              <div className="flex items-start gap-2" key={index}>
                <input
                  aria-label={t("tasks.engineConfig.enableSkill", {
                    n: index + 1,
                  })}
                  type="checkbox"
                  className="mt-9 size-4 accent-(--primary)"
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
                  {t("tasks.engineConfig.skillPath")}
                  <input
                    className={field}
                    value={skill.path}
                    placeholder={examples.skill}
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
                    <span className="mt-1 block font-mono text-[11.5px] text-subtle">
                      {skill.sha256.slice(0, 16)}
                    </span>
                  ) : null}
                </label>
                <Button
                  aria-label={t("tasks.engineConfig.removeSkill", {
                    n: index + 1,
                  })}
                  variant="ghost"
                  size="icon"
                  className="mt-7"
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
              {t("tasks.engineConfig.addSkill")}
            </Button>
          </div>
        ) : null}
        {tab === "mcp" ? (
          <div className="space-y-3">
            <p className="field-hint mt-0">
              {t("tasks.engineConfig.mcpHint")}
            </p>
            <label className={label}>
              {t("tasks.engineConfig.mcpJson")}
              <Textarea
                className="mt-2 min-h-[250px] font-mono text-[12.5px]"
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
                          command: examples.mcpCommand,
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
                  setError(t("tasks.engineConfig.fixMcp"));
                }
              }}
            >
              <Plus />
              {t("tasks.engineConfig.insertStdio")}
            </Button>

          </div>
        ) : null}
        {tab === "advanced" ? (
          <div className="space-y-4">
            <label className={label}>
              {t("tasks.engineConfig.env")}
              <Textarea
                className="mt-2 min-h-24 font-mono text-[12.5px]"
                value={envText}
                onChange={(e) => {
                  setEnvText(e.target.value);
                  change();
                }}
              />
            </label>
            <label className={label}>
              {t("tasks.engineConfig.secretEnv")}
              <Textarea
                className="mt-2 min-h-32 font-mono text-[12.5px]"
                value={secretEnvText}
                onChange={(e) => {
                  setSecretEnvText(e.target.value);
                  change();
                }}
              />
            </label>
            <p className="field-hint mt-0">
              {t("tasks.engineConfig.secretEnvExample", {
                example: `{"OPENAI_API_KEY":{"kind":"env","value":"ENGINE_A_KEY"}}`,
              })}
            </p>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="callout error">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="callout good">
            {t("tasks.engineConfig.saved")}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("tasks.engineConfig.close")}
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("tasks.engineConfig.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
