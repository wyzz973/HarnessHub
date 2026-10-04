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
import { t } from "@/lib/i18n";
import { tr } from "@/lib/i18n-react";
import { stateKey } from "@/lib/routing-state";
import {
  accountState,
  backendName,
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
  const [cancelling, setCancelling] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const siwc = target.backend === "siwc";
  const name = backendName(target.backend);
  const finish = (view: SignInView) => {
    if (view.status !== "succeeded") {
      setPhase({
        step: "failed",
        message:
          view.status === "cancelled"
            ? t("subscriptions.signIn.cancelled")
            : (view.error ?? t("subscriptions.signIn.incomplete")),
      });
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
  const busy = phase.step === "starting" || cancelling;
  // Cancelling a pending ChatGPT sign-in closes the daemon's callback
  // listener. While the browser's callback is completing it cannot be
  // cancelled; the attempt then finishes and polling shows the result.
  const cancel = () => {
    if (phase.step !== "waiting") {
      onClose();
      return;
    }
    setCancelling(true);
    setFailure(null);
    modelPlane()
      .subscriptions.cancelSignIn(phase.view.id)
      .then(
        () => {
          setCancelling(false);
          notify.success(t("subscriptions.signIn.cancelDone"));
          onClose();
        },
        (reason: unknown) => {
          setCancelling(false);
          const problem = failureOf(reason);
          setFailure(
            problem.code === "SIGN_IN_COMPLETING"
              ? {
                  ...problem,
                  message: t("subscriptions.signIn.completing"),
                }
              : problem.code === "SIGN_IN_NOT_PENDING"
                ? { ...problem, message: t("subscriptions.signIn.ended") }
                : problem,
          );
        },
      );
  };
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? cancel() : null)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>
            {siwc
              ? t("subscriptions.brand.chatgpt")
              : t("subscriptions.brand.copilot")}
          </DialogTitle>
          <DialogDescription>
            {target.credential
              ? t("subscriptions.signIn.again", {
                  name,
                  credential: target.credential,
                })
              : t("subscriptions.signIn.lede", { name })}
          </DialogDescription>
        </DialogHeader>
        {phase.step === "notice" || phase.step === "starting" ? (
          notice ? (
            <>
              <section
                className="space-y-2 rounded-xl border bg-muted/40 p-4 text-[13px] leading-6"
                aria-label={t("subscriptions.notice.label")}
              >
                <p className="font-medium">{notice.title}</p>
                {notice.text.split("\n").map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
                <p className="flex flex-wrap items-center gap-x-3 text-[12px] text-subtle">
                  <span>
                    {t("subscriptions.notice.version", {
                      version: notice.version,
                    })}
                  </span>
                  <a
                    className="inline-flex items-center gap-1 text-brand hover:underline"
                    href={notice.manageUsageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("subscriptions.notice.manageUsage")}
                    <ExternalLink className="size-3" />
                  </a>
                </p>
              </section>
              <Checkbox
                checked={accepted}
                onChange={setAccepted}
                disabled={busy}
              >
                {t("subscriptions.notice.accept")}
              </Checkbox>
              {!siwc ? (
                <fieldset className="space-y-2" disabled={busy}>
                  <legend className="field-label">
                    {t("subscriptions.copilot.authMode")}
                  </legend>
                  <label className="flex items-start gap-2.5 rounded-[10px] px-2 py-1.5 text-[13.5px] hover:bg-accent">
                    <input
                      type="radio"
                      name="copilot-auth"
                      className="mt-1 accent-(--primary)"
                      checked={auth === "login"}
                      onChange={() => setAuth("login")}
                    />
                    <span>
                      {t("subscriptions.copilot.cliLogin")}
                      <span className="block text-[12.5px] text-muted-foreground">
                        {t("subscriptions.copilot.cliLoginHint")}
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
                      {t("subscriptions.copilot.pat")}
                      <span className="block text-[12.5px] text-muted-foreground">
                        {t("subscriptions.copilot.patHint")}
                      </span>
                    </span>
                  </label>
                  {auth === "token" ? (
                    <input
                      className="field font-mono text-[13px]"
                      type="password"
                      aria-label={t("subscriptions.copilot.patShort")}
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
            <p className="callout error">
              {t("subscriptions.notice.loadFailed")}
            </p>
          )
        ) : phase.step === "waiting" ? (
          <div className="space-y-3" role="status">
            <p className="flex items-center gap-2 text-[13.5px]">
              <Loader2 className="size-4 animate-spin" />
              {t("subscriptions.signIn.waiting")}
              <span className="text-subtle">
                {tr("subscriptions.signIn.remaining", {
                  time: <Countdown expiresAt={phase.view.expiresAt} />,
                })}
              </span>
            </p>
            {phase.view.authorizeUrl ? (
              <p className="text-[12.5px] text-muted-foreground">
                {phase.popupBlocked
                  ? t("subscriptions.signIn.popupBlocked")
                  : t("subscriptions.signIn.noPopup")}
                <a
                  className="inline-flex items-center gap-1 text-brand hover:underline"
                  href={phase.view.authorizeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("subscriptions.brand.continue")}
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
                  ? t("subscriptions.signIn.doneChatgpt", {
                      email: phase.view.email
                        ? t("subscriptions.signIn.email", {
                            email: phase.view.email,
                          })
                        : "",
                    })
                  : t("subscriptions.signIn.doneCopilot", {
                      login: phase.view.login
                        ? t("subscriptions.signIn.login", {
                            login: phase.view.login,
                          })
                        : "",
                    })}
                {phase.view.firstSignIn ? " " : ""}
                {phase.view.firstSignIn
                  ? t("subscriptions.signIn.added", {
                      provider: phase.view.provider,
                      credential: phase.view.credential ?? "",
                    })
                  : ""}
              </span>
            </p>
            {phase.modelsError ? (
              <p className="callout warn">
                {t("subscriptions.signIn.modelsFailed", {
                  error: phase.modelsError,
                })}
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
                  ? t("subscriptions.signIn.manageChatgpt")
                  : t("subscriptions.signIn.manageCopilot")}
                <ExternalLink className="size-3" />
              </a>
            ) : null}
          </div>
        ) : (
          <p role="alert" className="callout error">
            {t("subscriptions.signIn.failed", { message: phase.message })}
          </p>
        )}
        <ErrorCallout failure={failure} />
        <DialogFooter>
          {phase.step === "done" ? (
            <Button onClick={onClose}>
              {t("subscriptions.signIn.finish")}
            </Button>
          ) : phase.step === "failed" ? (
            <>
              <Button variant="outline" onClick={onClose}>
                {t("common.close")}
              </Button>
              <Button
                onClick={() => {
                  setAccepted(false);
                  setPhase({ step: "notice" });
                }}
              >
                {t("common.retry")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={cancel}>
                {cancelling ? <Loader2 className="animate-spin" /> : null}
                {phase.step === "waiting"
                  ? t("subscriptions.signIn.cancel")
                  : t("common.cancel")}
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
                  {siwc
                    ? t("subscriptions.brand.continue")
                    : t("subscriptions.signIn.acceptAndSignIn")}
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
          <DialogTitle>{t("subscriptions.install.title")}</DialogTitle>
          <DialogDescription>
            {t("subscriptions.install.description", {
              version: setup.supportedSdkVersion,
            })}
          </DialogDescription>
        </DialogHeader>
        <pre className="overflow-x-auto rounded-xl border bg-muted p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap break-all">
          {setup.installCommand}
        </pre>
        <p className="text-[12.5px] text-muted-foreground">
          {tr("subscriptions.install.target", {
            directory: (
              <span className="font-mono break-all">{setup.sdkDirectory}</span>
            ),
          })}
        </p>
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
                .subscriptions.installCopilot()
                .then(
                  (installed) => {
                    setBusy(false);
                    notify.success(
                      t("subscriptions.install.done", {
                        version: installed.sdkVersion ?? "",
                      }).trim(),
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
            {busy
              ? t("subscriptions.install.installing")
              : t("subscriptions.install.confirm")}
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
        title={t("subscriptions.brand.copilot")}
        lede={t("subscriptions.copilot.ledeShort")}
      >
        <p className="callout neutral">
          {t("subscriptions.copilot.unavailable", { message: setup.message })}
        </p>
      </Card>
    );
  const readiness = copilotReadiness(setup.value);
  return (
    <Card
      title={t("subscriptions.brand.copilot")}
      lede={t("subscriptions.copilot.lede")}
    >
      <dl className="text-[13px]">
        <Row label="Copilot SDK">
          {readiness.sdk === "ready" ? (
            <span className="tag good">
              {t("subscriptions.copilot.installed", {
                version: setup.value.sdkVersion ?? "",
              })}
            </span>
          ) : readiness.sdk === "missing" ? (
            <span className="tag warn">
              {t("subscriptions.copilot.notInstalled")}
            </span>
          ) : (
            <span className="tag warn">
              {t("subscriptions.copilot.otherVersion", {
                version: setup.value.sdkVersion ?? "",
                supported: setup.value.supportedSdkVersion,
              })}
            </span>
          )}
        </Row>
        <Row label="Copilot CLI">
          {setup.value.cliPath ? (
            <span className="font-mono text-[12px] break-all">
              {setup.value.cliPath}
            </span>
          ) : (
            <span className="tag warn">
              {t("subscriptions.copilot.notFound")}
            </span>
          )}
        </Row>
      </dl>
      {!readiness.cli ? (
        <p className="callout info">{t("subscriptions.copilot.installCli")}</p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {readiness.sdk !== "ready" ? (
          <Button variant="outline" onClick={() => setInstalling(true)}>
            <Download />
            {t("subscriptions.copilot.installSdk")}
          </Button>
        ) : null}
        <Button disabled={!readiness.ready} onClick={onSignIn}>
          <LogIn />
          {t("subscriptions.copilot.signIn")}
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
          name={backendName(account.backend)}
        />
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{who}</span>
            <span className={`tag ${state.tone}`} title={state.hint}>
              {state.label}
            </span>
            {account.auth ? (
              <span className="tag">
                {account.auth === "token"
                  ? t("subscriptions.copilot.patShort")
                  : t("subscriptions.account.cliLogin")}
              </span>
            ) : null}
          </span>
          <span className="block truncate font-mono text-[12px] text-subtle">
            {backendName(account.backend)} · {account.provider}/
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
        {tr("subscriptions.account.accepted", {
          time: <LocalTime value={account.acceptedAt} />,
        })}
      </span>
      <span className="flex items-center">
        {!account.usable ? (
          <Button size="xs" variant="outline" onClick={onSignIn}>
            <LogIn />
            {t("subscriptions.account.signInAgain")}
          </Button>
        ) : null}
        {account.signedIn ? (
          <Button size="xs" variant="ghost" onClick={onSignOut}>
            <LogOut />
            {t("subscriptions.account.signOut")}
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("subscriptions.account.deleteLabel", { who })}
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
          title={t("common.nav.subscriptions")}
          lede={t("subscriptions.lede")}
        >
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("common.refresh")}
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
              aria-label={t("common.loading")}
            >
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : data.state === "error" ? (
            <LoadError message={data.message} retry={reload} />
          ) : (
            <>
              {data.value.accounts.length ? (
                <ul
                  className="panel"
                  aria-label={t("common.nav.subscriptions")}
                >
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
                <EmptyState
                  icon={CreditCard}
                  title={t("subscriptions.empty.title")}
                >
                  {t("subscriptions.empty.body")}
                </EmptyState>
              )}
              <div className="grid gap-4 lg:grid-cols-2">
                <Card
                  title={t("subscriptions.brand.chatgpt")}
                  lede={t("subscriptions.chatgpt.lede")}
                >
                  <p className="text-[13px] text-muted-foreground">
                    {t("subscriptions.chatgpt.body")}
                  </p>
                  <div className="flex justify-end">
                    <Button onClick={() => setSignIn({ backend: "siwc" })}>
                      <LogIn />
                      {t("subscriptions.brand.chatgpt")}
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
                {t("subscriptions.claudeUnavailable")}
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
          title={t("subscriptions.signOut.title", {
            who: signingOut
              ? (signingOut.email ?? signingOut.login ?? signingOut.credential)
              : "",
          })}
          description={
            signingOut?.backend === "copilot"
              ? t("subscriptions.signOut.copilot")
              : t("subscriptions.signOut.chatgpt")
          }
          action={t("subscriptions.account.signOut")}
          onClose={() => setSigningOut(null)}
          onConfirm={async () => {
            if (!signingOut) return;
            const result = await modelPlane().subscriptions.signOut(
              signingOut.provider,
              signingOut.credential,
            );
            notify.success(
              result.revoked
                ? t("subscriptions.signOut.revoked")
                : signingOut.backend === "siwc"
                  ? t("subscriptions.signOut.unconfirmed")
                  : t("subscriptions.signOut.tokenValid"),
            );
            reload();
          }}
        />
        <ConfirmDialog
          open={deleting !== null}
          title={t("subscriptions.delete.title", {
            who: deleting
              ? (deleting.email ?? deleting.login ?? deleting.credential)
              : "",
          })}
          description={t("subscriptions.delete.description")}
          action={t("subscriptions.delete.action")}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            if (!deleting) return;
            await modelPlane().credentials.remove(
              deleting.provider,
              deleting.credential,
            );
            notify.success(t("subscriptions.delete.done"));
            reload();
          }}
        />
      </div>
    </div>
  );
}
