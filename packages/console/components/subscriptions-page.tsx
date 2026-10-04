// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CircleCheck,
  CreditCard,
  Download,
  ExternalLink,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  HarnessHubError,
  type CopilotAuth,
  type CopilotSetupView,
  type SignInView,
  type SubscriptionAccountView,
  type SubscriptionBackend,
  type SubscriptionNoticeView,
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
import { BrandIcon } from "@/components/brand-icon";
import { failureOf, modelPlane, type Failure } from "@/lib/model-plane";
import { subscriptionIcons } from "@/lib/gateway-models";
import { stateKey } from "@/lib/routing-state";
import {
  accountState,
  backendNames,
  copilotReadiness,
  secondsLeft,
} from "@/lib/subscriptions";
import { notify } from "@/lib/toast";
import {
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorCallout,
  LoadError,
  LocalTime,
  PageHeader,
  Row,
  useLoaded,
} from "./model-plane-ui";
import {
  CredentialState,
  Readings,
  useRoutingStates,
  type RoutingStates,
} from "./routing-state";

type Setup =
  | { state: "ready"; value: CopilotSetupView }
  | { state: "unavailable"; message: string };

interface SubscriptionsData {
  notices: SubscriptionNoticeView[];
  accounts: SubscriptionAccountView[];
  copilot: Setup;
}

/** A sign-in being made: new, or again for an existing account. */
interface SignInTarget {
  backend: SubscriptionBackend;
  provider?: string;
  credential?: string;
  /** The account's way to sign in (Copilot), kept when signing in again. */
  auth?: CopilotAuth;
}

type SignInPhase =
  | { step: "notice" }
  | { step: "starting" }
  | { step: "waiting"; view: SignInView; popupBlocked: boolean }
  | { step: "done"; view: SignInView; modelsError?: string }
  | { step: "failed"; message: string };

/** Poll a pending ChatGPT sign-in; stops when it is decided or the dialog closes. */
function usePolling(
  id: string | undefined,
  onDecided: (view: SignInView) => void,
  onError: (reason: unknown) => void,
) {
  const decided = useRef(onDecided);
  const failed = useRef(onError);
  useEffect(() => {
    decided.current = onDecided;
    failed.current = onError;
  });
  useEffect(() => {
    if (!id) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = () => {
      modelPlane()
        .subscriptions.signIn(id)
        .then(
          (view) => {
            if (stopped) return;
            if (view.status === "pending")
              timer = window.setTimeout(poll, 1500);
            else decided.current(view);
          },
          (reason: unknown) => {
            if (!stopped) failed.current(reason);
          },
        );
    };
    timer = window.setTimeout(poll, 1500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [id]);
}

function Countdown({ expiresAt }: { expiresAt: string | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = secondsLeft(expiresAt, now);
  if (left === undefined) return null;
  return (
    <span className="tabular-nums">
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
    </span>
  );
}

/**
 * Sign an account in. The backend's risk notice comes first and must be
 * accepted explicitly; nothing starts before that. ChatGPT: the page opens
 * OpenAI's authorize URL in a new tab, OpenAI sends the browser back to the
 * daemon's loopback callback, and the page polls the attempt. Copilot: the
 * daemon signs in with the Copilot CLI's own login or a fine-grained PAT
 * and answers when done. Either way the provider's models are read after.
 */
function SignInDialog({
  target,
  notice,
  onClose,
  onSignedIn,
}: {
  target: SignInTarget;
  notice: SubscriptionNoticeView | undefined;
  onClose: () => void;
  onSignedIn: () => void;
}) {
  const [accepted, setAccepted] = useState(false);
  const [auth, setAuth] = useState<CopilotAuth>(target.auth ?? "login");
  const [token, setToken] = useState("");
  const [phase, setPhase] = useState<SignInPhase>({ step: "notice" });
  const [failure, setFailure] = useState<Failure | null>(null);
  const siwc = target.backend === "siwc";
  const name = backendNames[target.backend];
  const finish = (view: SignInView) => {
    if (view.status !== "succeeded") {
      setPhase({ step: "failed", message: view.error ?? "登录没有完成" });
      return;
    }
    // A sign-in through the API does not read the models; do it here, as `hh subscription login` does.
    modelPlane()
      .providers.refreshModels(view.provider)
      .then(
        () => setPhase({ step: "done", view }),
        (reason: unknown) =>
          setPhase({
            step: "done",
            view,
            modelsError: failureOf(reason).message,
          }),
      )
      .finally(onSignedIn);
  };
  usePolling(
    phase.step === "waiting" ? phase.view.id : undefined,
    finish,
    (reason) =>
      setPhase({ step: "failed", message: failureOf(reason).message }),
  );
  const start = () => {
    if (!notice) return;
    // Opened now, while the click still counts as the user's: a window opened
    // after the request returns would be blocked as a popup.
    const popup = siwc ? window.open("", "_blank") : null;
    if (popup) popup.opener = null;
    setPhase({ step: "starting" });
    setFailure(null);
    modelPlane()
      .subscriptions.startSignIn({
        backend: target.backend,
        acceptNotice: notice.version,
        ...(target.provider ? { provider: target.provider } : {}),
        ...(target.credential ? { credential: target.credential } : {}),
        ...(siwc ? {} : { auth, ...(auth === "token" ? { token } : {}) }),
      })
      .then(
        (view) => {
          setToken("");
          if (view.status !== "pending") {
            popup?.close();
            finish(view);
            return;
          }
          if (popup && view.authorizeUrl)
            popup.location.href = view.authorizeUrl;
          else popup?.close();
          setPhase({ step: "waiting", view, popupBlocked: !popup });
        },
        (reason: unknown) => {
          popup?.close();
          setPhase({ step: "notice" });
          setFailure(failureOf(reason));
        },
      );
  };
  const busy = phase.step === "starting";
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : null)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>
            {siwc ? "Use your ChatGPT plan" : "Use your GitHub Copilot plan"}
          </DialogTitle>
          <DialogDescription>
            {target.credential
              ? `重新登录 ${name} 账号 ${target.credential}。`
              : `用你自己的 ${name} 订阅为本机的 Agent 提供模型。`}
          </DialogDescription>
        </DialogHeader>
        {phase.step === "notice" || phase.step === "starting" ? (
          notice ? (
            <>
              <section
                className="space-y-2 rounded-xl border bg-muted/40 p-4 text-[13px] leading-6"
                aria-label="风险告知"
              >
                <p className="font-medium">{notice.title}</p>
                {notice.text.split("\n").map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
                <p className="flex flex-wrap items-center gap-x-3 text-[12px] text-subtle">
                  <span>告知版本 {notice.version}</span>
                  <a
                    className="inline-flex items-center gap-1 text-brand hover:underline"
                    href={notice.manageUsageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    管理用量
                    <ExternalLink className="size-3" />
                  </a>
                </p>
              </section>
              <Checkbox
                checked={accepted}
                onChange={setAccepted}
                disabled={busy}
              >
                我已阅读并接受以上告知
              </Checkbox>
              {!siwc ? (
                <fieldset className="space-y-2" disabled={busy}>
                  <legend className="field-label">登录方式</legend>
                  <label className="flex items-start gap-2.5 rounded-[10px] px-2 py-1.5 text-[13.5px] hover:bg-accent">
                    <input
                      type="radio"
                      name="copilot-auth"
                      className="mt-1 accent-(--primary)"
                      checked={auth === "login"}
                      onChange={() => setAuth("login")}
                    />
                    <span>
                      Copilot CLI 自己的登录
                      <span className="block text-[12.5px] text-muted-foreground">
                        先在终端运行 copilot 并用 /login 登录；HarnessHub
                        不读取这份登录。
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2.5 rounded-[10px] px-2 py-1.5 text-[13.5px] hover:bg-accent">
                    <input
                      type="radio"
                      name="copilot-auth"
                      className="mt-1 accent-(--primary)"
                      checked={auth === "token"}
                      onChange={() => setAuth("token")}
                    />
                    <span>
                      细粒度个人访问令牌
                      <span className="block text-[12.5px] text-muted-foreground">
                        在 GitHub 创建、带 Copilot Requests 权限的
                        github_pat_…；只发送一次，保存在秘密存储中。
                      </span>
                    </span>
                  </label>
                  {auth === "token" ? (
                    <input
                      className="field font-mono text-[13px]"
                      type="password"
                      aria-label="个人访问令牌"
                      value={token}
                      autoComplete="new-password"
                      spellCheck={false}
                      placeholder="github_pat_…"
                      onChange={(event) => setToken(event.target.value)}
                    />
                  ) : null}
                </fieldset>
              ) : null}
            </>
          ) : (
            <p className="callout error">读取风险告知失败，不能登录。</p>
          )
        ) : phase.step === "waiting" ? (
          <div className="space-y-3" role="status">
            <p className="flex items-center gap-2 text-[13.5px]">
              <Loader2 className="size-4 animate-spin" />
              在新标签页中用 OpenAI 的页面登录并授权；完成后这里会自动继续。
              <span className="text-subtle">
                剩余 <Countdown expiresAt={phase.view.expiresAt} />
              </span>
            </p>
            {phase.view.authorizeUrl ? (
              <p className="text-[12.5px] text-muted-foreground">
                {phase.popupBlocked
                  ? "浏览器拦截了新标签页，"
                  : "没有看到新标签页？"}
                <a
                  className="inline-flex items-center gap-1 text-brand hover:underline"
                  href={phase.view.authorizeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Continue with ChatGPT
                  <ExternalLink className="size-3" />
                </a>
              </p>
            ) : null}
          </div>
        ) : phase.step === "done" ? (
          <div className="space-y-2">
            <p className="callout good">
              <CircleCheck className="mt-0.5 size-4 shrink-0" />
              <span>
                {siwc
                  ? `You're using your ChatGPT plan${phase.view.email ? `（${phase.view.email}）` : ""}。HarnessHub 中符合条件的用量计入你的 ChatGPT 套餐。`
                  : `已登录 GitHub Copilot${phase.view.login ? `：${phase.view.login}` : ""}。`}
                {phase.view.firstSignIn
                  ? ` 已添加 provider ${phase.view.provider}，账号 ${phase.view.credential}。`
                  : ""}
              </span>
            </p>
            {phase.modelsError ? (
              <p className="callout warn">
                读取模型列表失败：{phase.modelsError}。可以稍后在 Provider
                页刷新。
              </p>
            ) : null}
            {notice ? (
              <a
                className="inline-flex items-center gap-1 text-[13px] text-brand hover:underline"
                href={notice.manageUsageUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {siwc
                  ? "在 ChatGPT 设置中管理用量"
                  : "在 GitHub 计费设置中查看用量"}
                <ExternalLink className="size-3" />
              </a>
            ) : null}
          </div>
        ) : (
          <p role="alert" className="callout error">
            登录失败：{phase.message}
          </p>
        )}
        <ErrorCallout failure={failure} />
        <DialogFooter>
          {phase.step === "done" ? (
            <Button onClick={onClose}>完成</Button>
          ) : phase.step === "failed" ? (
            <>
              <Button variant="outline" onClick={onClose}>
                关闭
              </Button>
              <Button
                onClick={() => {
                  setAccepted(false);
                  setPhase({ step: "notice" });
                }}
              >
                重试
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                {phase.step === "waiting" ? "不再等待" : "取消"}
              </Button>
              {phase.step !== "waiting" ? (
                <Button
                  disabled={
                    busy ||
                    !accepted ||
                    !notice ||
                    (!siwc && auth === "token" && !token)
                  }
                  onClick={start}
                >
                  {busy ? <Loader2 className="animate-spin" /> : <LogIn />}
                  {siwc ? "Continue with ChatGPT" : "接受并登录"}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Install the supported Copilot SDK with the user's npm, after confirming. */
function InstallDialog({
  setup,
  onClose,
  onInstalled,
}: {
  setup: CopilotSetupView;
  onClose: () => void;
  onInstalled: (setup: CopilotSetupView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : null)}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>安装 Copilot SDK</DialogTitle>
          <DialogDescription>
            GitHub 的 Copilot SDK 是可选附加组件，不随 HarnessHub
            分发。守护进程会用你 PATH 上的 npm 安装受支持的版本{" "}
            {setup.supportedSdkVersion}
            ，不装 SDK
            自带的平台运行时，也不运行依赖的安装脚本；可能需要几分钟。
          </DialogDescription>
        </DialogHeader>
        <pre className="overflow-x-auto rounded-xl border bg-muted p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap break-all">
          {setup.installCommand}
        </pre>
        <p className="text-[12.5px] text-muted-foreground">
          安装到{" "}
          <span className="font-mono break-all">{setup.sdkDirectory}</span>
          。没有 npm 时可以在终端自己运行上面的命令。
        </p>
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
                .subscriptions.installCopilot()
                .then(
                  (installed) => {
                    setBusy(false);
                    notify.success(
                      `已安装 Copilot SDK ${installed.sdkVersion ?? ""}`.trim(),
                    );
                    onInstalled(installed);
                    onClose();
                  },
                  (reason: unknown) => {
                    setBusy(false);
                    setFailure(failureOf(reason));
                  },
                );
            }}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Download />}
            {busy ? "正在安装…" : "确认安装"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CopilotCard({
  setup,
  onSignIn,
  onSetup,
}: {
  setup: Setup;
  onSignIn: () => void;
  onSetup: (setup: CopilotSetupView) => void;
}) {
  const [installing, setInstalling] = useState(false);
  if (setup.state === "unavailable")
    return (
      <Card
        title="Use your GitHub Copilot plan"
        lede="经 GitHub 的 Copilot SDK 驱动你安装的 Copilot CLI。"
      >
        <p className="callout neutral">
          这个守护进程不提供 Copilot 账号：{setup.message}
        </p>
      </Card>
    );
  const readiness = copilotReadiness(setup.value);
  return (
    <Card
      title="Use your GitHub Copilot plan"
      lede="经 GitHub 的 Copilot SDK 驱动你安装的 Copilot CLI，用 CLI 自己的登录或细粒度个人访问令牌。"
    >
      <dl className="text-[13px]">
        <Row label="Copilot SDK">
          {readiness.sdk === "ready" ? (
            <span className="tag good">已安装 {setup.value.sdkVersion}</span>
          ) : readiness.sdk === "missing" ? (
            <span className="tag warn">未安装</span>
          ) : (
            <span className="tag warn">
              {setup.value.sdkVersion}（支持 {setup.value.supportedSdkVersion}）
            </span>
          )}
        </Row>
        <Row label="Copilot CLI">
          {setup.value.cliPath ? (
            <span className="font-mono text-[12px] break-all">
              {setup.value.cliPath}
            </span>
          ) : (
            <span className="tag warn">未找到</span>
          )}
        </Row>
      </dl>
      {!readiness.cli ? (
        <p className="callout info">
          先安装 GitHub 的 Copilot CLI（命令 copilot 在 PATH 上），再回到这里。
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {readiness.sdk !== "ready" ? (
          <Button variant="outline" onClick={() => setInstalling(true)}>
            <Download />
            安装 SDK
          </Button>
        ) : null}
        <Button disabled={!readiness.ready} onClick={onSignIn}>
          <LogIn />
          登录 Copilot
        </Button>
      </div>
      {installing ? (
        <InstallDialog
          setup={setup.value}
          onClose={() => setInstalling(false)}
          onInstalled={onSetup}
        />
      ) : null}
    </Card>
  );
}

function AccountRow({
  account,
  states,
  onSignIn,
  onSignOut,
  onDelete,
}: {
  account: SubscriptionAccountView;
  /** The gateway's routing state: the breaker and the allowance readings. */
  states: RoutingStates;
  onSignIn: () => void;
  onSignOut: () => void;
  onDelete: () => void;
}) {
  const state = accountState(account);
  const who = account.email ?? account.login ?? account.credential;
  const routing =
    states.state === "ready"
      ? states.byCredential.get(stateKey(account.provider, account.credential))
      : undefined;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3.5 last:border-b-0 sm:px-5">
      <span className="flex min-w-0 flex-1 basis-[240px] items-center gap-3">
        <BrandIcon
          slug={subscriptionIcons[account.backend]}
          name={backendNames[account.backend]}
        />
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{who}</span>
            <span className={`tag ${state.tone}`} title={state.hint}>
              {state.label}
            </span>
            {account.auth ? (
              <span className="tag">
                {account.auth === "token" ? "个人访问令牌" : "CLI 登录"}
              </span>
            ) : null}
          </span>
          <span className="block truncate font-mono text-[12px] text-subtle">
            {backendNames[account.backend]} · {account.provider}/
            {account.credential}
          </span>
        </span>
      </span>
      {routing && routing.state !== "closed" ? (
        <CredentialState state={routing} />
      ) : null}
      {routing?.readings.length ? (
        <Readings readings={routing.readings} className="w-[200px]" />
      ) : null}
      <span className="text-[12px] text-subtle">
        接受告知于 <LocalTime value={account.acceptedAt} />
      </span>
      <span className="flex items-center">
        {!account.usable ? (
          <Button size="xs" variant="outline" onClick={onSignIn}>
            <LogIn />
            重新登录
          </Button>
        ) : null}
        {account.signedIn ? (
          <Button size="xs" variant="ghost" onClick={onSignOut}>
            <LogOut />
            退出登录
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`删除 ${who}`}
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      </span>
    </li>
  );
}

/**
 * Subscription accounts (docs/subscriptions.md): the user's own ChatGPT
 * plan and GitHub Copilot accounts as providers of models. Each account
 * serves agents on this computer only, and only after its backend's current
 * risk notice was accepted.
 */
export function SubscriptionsPage() {
  const load = useCallback(async (): Promise<SubscriptionsData> => {
    const client = modelPlane();
    const [notices, accounts, copilot] = await Promise.all([
      client.subscriptions.notices(),
      client.subscriptions.accounts(),
      client.subscriptions.copilotSetup().then(
        (value): Setup => ({ state: "ready", value }),
        (reason: unknown): Setup => {
          if (
            reason instanceof HarnessHubError &&
            reason.code === "COPILOT_UNAVAILABLE"
          )
            return { state: "unavailable", message: reason.message };
          throw reason;
        },
      ),
    ]);
    return { notices: notices.items, accounts: accounts.items, copilot };
  }, []);
  const [data, reload] = useLoaded(load);
  const [states] = useRoutingStates();
  const [setup, setSetup] = useState<CopilotSetupView | null>(null);
  const [signIn, setSignIn] = useState<SignInTarget | null>(null);
  const [signingOut, setSigningOut] = useState<SubscriptionAccountView | null>(
    null,
  );
  const [deleting, setDeleting] = useState<SubscriptionAccountView | null>(
    null,
  );
  const notice = (backend: SubscriptionBackend) =>
    data.state === "ready"
      ? data.value.notices.find((item) => item.backend === backend)
      : undefined;
  return (
    <div className="page-body">
      <div className="page-column max-w-[1040px]">
        <PageHeader
          title="订阅账号"
          lede="用你自己的 ChatGPT 套餐或 GitHub Copilot 订阅为本机的 Agent 提供模型。账号只服务这台电脑上的 Agent，局域网共享的 Key 看不到它们。"
        >
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="刷新"
            onClick={() => {
              setSetup(null);
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
              {data.value.accounts.length ? (
                <ul className="panel" aria-label="订阅账号">
                  {data.value.accounts.map((account) => (
                    <AccountRow
                      key={`${account.provider}/${account.credential}`}
                      account={account}
                      states={states}
                      onSignIn={() =>
                        setSignIn({
                          backend: account.backend,
                          provider: account.provider,
                          credential: account.credential,
                          ...(account.auth ? { auth: account.auth } : {}),
                        })
                      }
                      onSignOut={() => setSigningOut(account)}
                      onDelete={() => setDeleting(account)}
                    />
                  ))}
                </ul>
              ) : (
                <EmptyState icon={CreditCard} title="还没有订阅账号">
                  登录 ChatGPT 或 GitHub Copilot 后，账号作为 provider
                  出现在模型选择中。
                </EmptyState>
              )}
              <div className="grid gap-4 lg:grid-cols-2">
                <Card
                  title="Use your ChatGPT plan"
                  lede="经 OpenAI 的 Sign in with ChatGPT for open-source apps（预览）使用 Plus、Pro 等套餐。"
                >
                  <p className="text-[13px] text-muted-foreground">
                    登录在 OpenAI 自己的页面完成，HarnessHub
                    不经手你的密码；请求计入套餐的用量限制，可在 ChatGPT
                    设置中查看和限制。
                  </p>
                  <div className="flex justify-end">
                    <Button onClick={() => setSignIn({ backend: "siwc" })}>
                      <LogIn />
                      Use your ChatGPT plan
                    </Button>
                  </div>
                </Card>
                <CopilotCard
                  setup={
                    setup
                      ? { state: "ready", value: setup }
                      : data.value.copilot
                  }
                  onSetup={setSetup}
                  onSignIn={() => setSignIn({ backend: "copilot" })}
                />
              </div>
              <p className="text-[12.5px] text-muted-foreground">
                Claude 订阅不可用：Anthropic 不允许第三方应用经 Free、Pro、Max
                套餐转发请求；使用 Claude 模型请添加 Anthropic API Key。
              </p>
            </>
          )}
        </div>
        {signIn ? (
          <SignInDialog
            target={signIn}
            notice={notice(signIn.backend)}
            onClose={() => setSignIn(null)}
            onSignedIn={reload}
          />
        ) : null}
        <ConfirmDialog
          open={signingOut !== null}
          title={`退出 ${signingOut ? (signingOut.email ?? signingOut.login ?? signingOut.credential) : ""}`}
          description={
            signingOut?.backend === "copilot"
              ? "停止这个账号的 Copilot 宿主进程并清除令牌；账号登记保留，以后可以重新登录。Copilot CLI 自己的登录不受影响，个人访问令牌在你于 GitHub 撤销之前仍然有效。"
              : "向 OpenAI 撤销这个账号的会话并清除令牌；账号登记保留，以后可以重新登录。"
          }
          action="退出登录"
          onClose={() => setSigningOut(null)}
          onConfirm={async () => {
            if (!signingOut) return;
            const result = await modelPlane().subscriptions.signOut(
              signingOut.provider,
              signingOut.credential,
            );
            notify.success(
              result.revoked
                ? "已退出登录，会话已撤销"
                : signingOut.backend === "siwc"
                  ? "已退出登录；OpenAI 没有确认撤销，可在 ChatGPT 设置中断开 HarnessHub"
                  : "已退出登录；令牌在 GitHub 撤销之前仍然有效",
            );
            reload();
          }}
        />
        <ConfirmDialog
          open={deleting !== null}
          title={`删除 ${deleting ? (deleting.email ?? deleting.login ?? deleting.credential) : ""}`}
          description="先结束这个账号与厂商的会话，再删除它的令牌与登记。撤销没有确认也会删除。"
          action="删除"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            if (!deleting) return;
            await modelPlane().credentials.remove(
              deleting.provider,
              deleting.credential,
            );
            notify.success("已删除账号");
            reload();
          }}
        />
      </div>
    </div>
  );
}
