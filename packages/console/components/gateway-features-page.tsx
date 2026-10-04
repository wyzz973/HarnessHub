// SPDX-License-Identifier: MIT
import { useCallback, useState } from "react";
import {
  Image as ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import type {
  GatewayFeaturesView,
  ProviderConfig,
  SearchBackendKind,
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
import { Switch } from "@/components/ui/switch";
import { ModelPicker } from "@/components/model-picker";
import {
  ruleOf,
  rulesWith,
  searchKinds,
  type RuleForm,
} from "@/lib/gateway-features";
import { gatewayModels, type GatewayModels } from "@/lib/gateway-models";
import { failureOf, modelPlane, type Failure } from "@/lib/model-plane";
import { navigate } from "@/lib/router";
import { notify } from "@/lib/toast";
import {
  Card,
  Checkbox,
  ConfirmDialog,
  ErrorCallout,
  LoadError,
  PageHeader,
  useLoaded,
} from "./model-plane-ui";

/** The details of a refused change, without the JSON Pointers. */
function Details({ failure }: { failure: Failure | null }) {
  const details = Object.values(failure?.fields ?? {});
  if (!details.length) return null;
  return (
    <ul className="callout error block list-disc space-y-0.5 pl-8">
      {details.map((detail) => (
        <li key={detail}>{detail}</li>
      ))}
    </ul>
  );
}

/**
 * Outbound redaction: on by default; turning it off asks first. The
 * user's rules are added (one of the same name is replaced) and removed
 * one at a time, each a `PUT` of the whole list.
 */
function Redaction({
  features,
  onChange,
}: {
  features: GatewayFeaturesView;
  onChange: (features: GatewayFeaturesView) => void;
}) {
  const [form, setForm] = useState<RuleForm>({
    name: "",
    pattern: "",
    ignoreCase: false,
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [disabling, setDisabling] = useState(false);
  const save = (
    input: Parameters<
      ReturnType<typeof modelPlane>["gatewayFeatures"]["setRedaction"]
    >[0],
    done: string,
  ) => {
    setBusy(true);
    setFailure(null);
    return modelPlane()
      .gatewayFeatures.setRedaction(input)
      .then(
        (next) => {
          setBusy(false);
          onChange(next);
          notify.success(done);
          return true;
        },
        (reason: unknown) => {
          setBusy(false);
          setFailure(failureOf(reason));
          return false;
        },
      );
  };
  const rules = features.redaction.rules;
  return (
    <Card
      title="出站脱敏"
      lede="请求发往上游之前，把已知的秘密换成占位符；模型在工具调用参数中写回占位符时还原为原值，写给人看的文本保留占位符。"
      aside={
        <Switch
          checked={features.redaction.enabled}
          disabled={busy}
          aria-label="出站脱敏"
          onCheckedChange={(checked) => {
            if (checked) void save({ enabled: true }, "已开启出站脱敏");
            else setDisabling(true);
          }}
        />
      }
    >
      <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-muted-foreground">
        <li>Gateway Key、守护进程的管理令牌</li>
        <li>本进程解析过的 provider 凭据与订阅令牌（至少 8 个字符的精确值）</li>
        <li>下面的规则匹配到的值（有分组时取第 1 组）</li>
      </ul>
      {!features.redaction.enabled ? (
        <p className="callout warn">
          出站脱敏已关闭：提示词与工具结果中出现的秘密会原样发给上游。
        </p>
      ) : null}
      <div className="overflow-x-auto rounded-xl border">
        <table className="data-table min-w-[520px]">
          <thead>
            <tr>
              <th>规则</th>
              <th>正则表达式</th>
              <th>大小写</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.name}>
                <td className="font-mono text-[12.5px]">{rule.name}</td>
                <td className="max-w-[320px] font-mono text-[12.5px] break-all">
                  {rule.pattern}
                </td>
                <td className="text-[12.5px]">
                  {rule.flags === "i" ? "忽略" : "区分"}
                </td>
                <td className="w-[56px] text-right">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`删除规则 ${rule.name}`}
                    disabled={busy}
                    onClick={() =>
                      void save(
                        {
                          rules: rulesWith(features, { remove: rule.name }),
                        },
                        `已删除规则 ${rule.name}`,
                      )
                    }
                  >
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rules.length ? (
          <p className="px-4 py-3 text-[13px] text-muted-foreground">
            没有自己的规则，只替换上面列出的已知秘密。
          </p>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-[180px_1fr_auto] sm:items-end">
        <label className="field-label">
          规则名
          <input
            className="field font-mono text-[13px]"
            value={form.name}
            placeholder="codename"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) =>
              setForm((current) => ({ ...current, name: event.target.value }))
            }
          />
        </label>
        <label className="field-label">
          正则表达式
          <input
            className="field font-mono text-[13px]"
            value={form.pattern}
            placeholder="falcon-[0-9]+"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                pattern: event.target.value,
              }))
            }
          />
        </label>
        <Button
          variant="outline"
          disabled={busy || !form.name.trim() || !form.pattern}
          onClick={() => {
            const rule = ruleOf(form);
            void save(
              { rules: rulesWith(features, { add: rule }) },
              `已保存规则 ${rule.name}`,
            ).then((saved) => {
              if (saved) setForm({ name: "", pattern: "", ignoreCase: false });
            });
          }}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          添加规则
        </Button>
      </div>
      <Checkbox
        checked={form.ignoreCase}
        onChange={(ignoreCase) =>
          setForm((current) => ({ ...current, ignoreCase }))
        }
      >
        忽略大小写
      </Checkbox>
      <p className="field-hint">
        JavaScript
        正则表达式；规则名是占位符中的种类（字母、数字与下划线），同名的规则被替换。
      </p>
      <ErrorCallout failure={failure} />
      <Details failure={failure} />
      <ConfirmDialog
        open={disabling}
        title="关闭出站脱敏"
        description="关闭后，提示词、工具结果与搜索查询中出现的 Gateway Key、provider 凭据和管理令牌会原样发给上游厂商。"
        action="关闭脱敏"
        onClose={() => setDisabling(false)}
        onConfirm={async () => {
          onChange(
            await modelPlane().gatewayFeatures.setRedaction({ enabled: false }),
          );
          notify.success("已关闭出站脱敏");
        }}
      />
    </Card>
  );
}

/** The model that describes images for models without image input, or none. */
function Vision({
  features,
  models,
  onChange,
}: {
  features: GatewayFeaturesView;
  models: GatewayModels;
  onChange: (features: GatewayFeaturesView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const choose = (model: string | undefined) => {
    if (model === features.vision?.model) return;
    setBusy(true);
    setFailure(null);
    const client = modelPlane().gatewayFeatures;
    (model === undefined ? client.clearVision() : client.setVision(model)).then(
      (next) => {
        setBusy(false);
        onChange(next);
        notify.success(
          model === undefined ? "已关闭视觉兜底" : `视觉兜底使用 ${model}`,
        );
      },
      (reason: unknown) => {
        setBusy(false);
        setFailure(failureOf(reason));
      },
    );
  };
  return (
    <Card
      title="视觉兜底"
      lede="请求带图片、而目标模型的元数据表明它不接受图片时，先由这里的模型把每张图片描述成文字（逐字转写图中文字），再交给目标模型。"
    >
      <div className="max-w-[420px]">
        <ModelPicker
          label="视觉模型"
          models={models}
          value={features.vision?.model}
          none="不使用：图片换成占位文字"
          disabled={busy || !models.sections.length}
          onChange={choose}
        />
      </div>
      <p className="field-hint">
        选择能看图的模型或路由组。描述调用经网关自己的路由、熔断与脱敏，作为
        Agent harnesshub-vision
        的独立调用记账，按视觉模型的价格计费；同一张图片的描述会缓存。
      </p>
      <ErrorCallout failure={failure} />
      <Details failure={failure} />
    </Card>
  );
}

/** Register a search API; its key is sent once and kept in the secret store. */
function AddSearchDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (features: GatewayFeaturesView) => void;
}) {
  const [kind, setKind] = useState<SearchBackendKind>("tavily");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const info = searchKinds[kind];
  const ready =
    (info.key === "optional" || key.length > 0) &&
    (info.baseUrl === "optional" || baseUrl.trim().length > 0);
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : null)}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>添加搜索后端</DialogTitle>
          <DialogDescription>
            网关按登记顺序使用后端，前一个失败或没有结果时用下一个。查询发出之前同样经过出站脱敏。
          </DialogDescription>
        </DialogHeader>
        <label className="field-label">
          服务
          <select
            className="field"
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as SearchBackendKind)
            }
          >
            {(Object.keys(searchKinds) as SearchBackendKind[]).map((item) => (
              <option key={item} value={item}>
                {searchKinds[item].name}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          API Key
          {info.key === "optional" ? (
            <span className="text-subtle">（实例需要时填写）</span>
          ) : null}
          <input
            className="field font-mono text-[13px]"
            type="password"
            value={key}
            autoComplete="new-password"
            spellCheck={false}
            onChange={(event) => setKey(event.target.value)}
          />
          <span className="field-hint block">
            只发送一次，保存在守护进程的秘密存储中。
          </span>
        </label>
        <label className="field-label">
          {info.baseUrl === "required" ? "实例地址" : "API 地址（可选）"}
          <input
            className="field font-mono text-[13px]"
            value={baseUrl}
            autoComplete="off"
            spellCheck={false}
            placeholder={
              info.baseUrl === "required"
                ? "http://127.0.0.1:8888"
                : `缺省为 ${info.name} 的官方地址`
            }
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <ErrorCallout failure={failure} />
        <Details failure={failure} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={busy || !ready}
            onClick={() => {
              setBusy(true);
              setFailure(null);
              modelPlane()
                .gatewayFeatures.addSearch({
                  kind,
                  ...(key ? { key } : {}),
                  ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
                })
                .then(
                  (next) => {
                    setBusy(false);
                    setKey("");
                    onAdded(next);
                    notify.success(`已添加 ${info.name}`);
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
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WebSearch({
  features,
  onChange,
}: {
  features: GatewayFeaturesView;
  onChange: (features: GatewayFeaturesView) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const backends = features.search?.backends ?? [];
  return (
    <Card
      title="联网搜索模拟"
      lede="客户端给模型提供厂商自己执行的联网搜索（Responses 的 web_search、Anthropic 的 web_search_*），而上游执行不了时，由网关调用这里的搜索后端完成。没有后端时这项功能关闭。"
      aside={
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus />
          添加后端
        </Button>
      }
    >
      {backends.length ? (
        <ol className="divide-y rounded-xl border">
          {backends.map((backend, index) => (
            <li
              key={backend.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
            >
              <span className="text-[12px] text-subtle tabular-nums">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px]">
                  {searchKinds[backend.kind].name}
                  <span className="ml-2 font-mono text-[12px] text-subtle">
                    {backend.id}
                  </span>
                </span>
                {backend.baseUrl ? (
                  <span className="block font-mono text-[12px] break-all text-muted-foreground">
                    {backend.baseUrl}
                  </span>
                ) : null}
              </span>
              <span className={`tag ${backend.hasKey ? "good" : ""}`}>
                {backend.hasKey ? "Key 已保存" : "无 Key"}
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`删除 ${backend.id}`}
                onClick={() => setRemoving(backend.id)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Search className="size-4" />
          没有搜索后端：翻译时这类工具被拒绝，直通时原样发送。
        </p>
      )}
      {adding ? (
        <AddSearchDialog onClose={() => setAdding(false)} onAdded={onChange} />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={`删除搜索后端 ${removing ?? ""}`}
        description="网关不再使用它，保存的 Key 一并删除。"
        action="删除"
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          onChange(await modelPlane().gatewayFeatures.removeSearch(removing));
          notify.success(`已删除 ${removing}`);
        }}
      />
    </Card>
  );
}

/** Image generation goes to providers with an image endpoint; they are set on the provider. */
function Images({ providers }: { providers: readonly ProviderConfig[] }) {
  const serving = providers.filter((provider) => provider.imageEndpoint);
  return (
    <Card
      title="图像生成"
      lede="网关的 POST /v1/images/generations（OpenAI Images）直通到设置了图像端点的 provider；model 是 Model Ref 或路由组，订阅 provider 不参与。"
      aside={
        <Button
          size="sm"
          variant="outline"
          onClick={() => navigate("providers")}
        >
          <ImageIcon />在 Provider 中设置
        </Button>
      }
    >
      {serving.length ? (
        <ul className="space-y-1 text-[13px]">
          {serving.map((provider) => (
            <li key={provider.id} className="flex flex-wrap gap-x-2">
              <span>{provider.name}</span>
              <span className="font-mono text-[12px] break-all text-muted-foreground">
                {provider.imageEndpoint}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          还没有 provider 设置图像端点，图像请求返回 404 images_unavailable。
        </p>
      )}
    </Card>
  );
}

/** The gateway's optional features (docs/gateway-features.md); changes apply to the next request. */
export function GatewayFeaturesPage({ tabs }: { tabs: React.ReactNode }) {
  const load = useCallback(async () => {
    const client = modelPlane();
    const [features, providers, presets, groups, autoGroups] =
      await Promise.all([
        client.gatewayFeatures.get(),
        client.providers.list(),
        client.presets.list(),
        client.routeGroups.list(),
        client.autoGroups.list(),
      ]);
    return {
      features,
      providers: providers.items,
      models: gatewayModels(
        providers.items,
        presets.items,
        groups.items,
        autoGroups.items,
      ),
    };
  }, []);
  const [data, reload] = useLoaded(load);
  const [features, setFeatures] = useState<GatewayFeaturesView | null>(null);
  return (
    <div className="page-body">
      <div className="page-column max-w-[880px]">
        {tabs}
        <PageHeader
          title="网关功能"
          lede="共享模型网关的可选能力。修改立即保存在数据目录中，对下一个请求生效。"
        >
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="刷新"
            onClick={() => {
              setFeatures(null);
              reload();
            }}
          >
            <RefreshCw />
          </Button>
        </PageHeader>
        <div className="mt-6 space-y-4">
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
            <>
              <Redaction
                features={features ?? data.value.features}
                onChange={setFeatures}
              />
              <Vision
                features={features ?? data.value.features}
                models={data.value.models}
                onChange={setFeatures}
              />
              <WebSearch
                features={features ?? data.value.features}
                onChange={setFeatures}
              />
              <Images providers={data.value.providers} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
