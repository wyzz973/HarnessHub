import { Check, Circle, CircleAlert, Loader2, Pause } from "lucide-react";
import { cn } from "@/lib/utils";
import { statusNames } from "@/lib/presentation";
export function Status({ status }: { status: string }) {
  const moving = [
    "running",
    "planning",
    "starting",
    "cancelling",
    "finalizing",
  ].includes(status);
  const failed = ["failed", "interrupted", "timed_out"].includes(status);
  const waiting = ["waiting_permission", "draft"].includes(status);
  const Icon = moving
    ? Loader2
    : failed
      ? CircleAlert
      : status === "completed"
        ? Check
        : waiting
          ? Pause
          : Circle;
  return (
    <span
      className={cn(
        "status-badge",
        failed && "error",
        waiting && "warning",
        ["cancelled", "pending", "blocked", "queued"].includes(status) &&
          "neutral",
      )}
    >
      <Icon className={cn("size-3", moving && "animate-spin")} />
      {statusNames[status] ?? status}
    </span>
  );
}
