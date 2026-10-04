// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { failureOf, referenceNames, type Failure } from "@/lib/model-plane";

export type Loaded<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "error"; message: string };

/** Load on mount and on `reload()`; a later load never shows an earlier result. */
export function useLoaded<T>(load: () => Promise<T>) {
  const [value, setValue] = useState<Loaded<T>>({ state: "loading" });
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let current = true;
    load().then(
      (result) => {
        if (current) setValue({ state: "ready", value: result });
      },
      (reason: unknown) => {
        if (current)
          setValue({ state: "error", message: failureOf(reason).message });
      },
    );
    return () => {
      current = false;
    };
  }, [load, epoch]);
  const reload = useCallback(() => setEpoch((n) => n + 1), []);
  return [value, reload] as const;
}

export function ErrorCallout({
  failure,
  className,
}: {
  failure: Failure | null;
  className?: string;
}) {
  if (!failure) return null;
  return (
    <div role="alert" className={`callout error ${className ?? ""}`}>
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p>{failure.message}</p>
        {failure.references.length ? (
          <ul className="mt-1 list-disc pl-5">
            {failure.references.map((item) => (
              <li key={`${item.type}:${item.id}`}>
                {referenceNames[item.type] ?? item.type}{" "}
                <span className="font-mono">{item.id}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/** The daemon's message for one input, located by its JSON Pointer. */
export function FieldError({
  failure,
  pointer,
}: {
  failure: Failure | null;
  pointer: string;
}) {
  const detail = failure?.fields[pointer];
  if (!detail) return null;
  return (
    <span role="alert" className="field-hint block text-danger">
      {detail}
    </span>
  );
}

/** Pointers that no field of the form shows, so the message is not lost. */
export function OtherFieldErrors({
  failure,
  shown,
}: {
  failure: Failure | null;
  shown: string[];
}) {
  const rest = Object.entries(failure?.fields ?? {}).filter(
    ([pointer]) => !shown.includes(pointer),
  );
  if (!rest.length) return null;
  return (
    <ul className="callout error block list-disc space-y-0.5 pl-8">
      {rest.map(([pointer, detail]) => (
        <li key={pointer}>
          <span className="font-mono">{pointer || "/"}</span> {detail}
        </li>
      ))}
    </ul>
  );
}

/**
 * A destructive action behind a confirmation. The action's failure (for
 * example a 409 with the records that block it) stays in the dialog.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  action,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  action: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) {
          setFailure(null);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <ErrorCallout failure={failure} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setFailure(null);
              onConfirm().then(
                () => {
                  setBusy(false);
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
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PageHeader({
  title,
  lede,
  children,
}: {
  title: string;
  lede: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="page-title">{title}</h1>
        <p className="page-lede">{lede}</p>
      </div>
      {children ? (
        <div className="flex items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-h-9 items-center gap-2.5 rounded-[10px] px-2 text-[13.5px] hover:bg-accent">
      <input
        type="checkbox"
        className="size-4 accent-(--primary)"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0 flex-1 break-all">{children}</span>
    </label>
  );
}

export function LocalTime({ value }: { value: string | undefined }) {
  if (!value) return <span className="text-subtle">—</span>;
  return (
    <time dateTime={value} title={value}>
      {new Date(value).toLocaleString()}
    </time>
  );
}
