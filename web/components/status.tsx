import { Check, Circle, CircleAlert, Loader2, Pause } from "lucide-react";
import { cn } from "@/lib/utils";
import { statusNames } from "@/lib/presentation";

const moving = ["running", "planning", "starting", "cancelling", "finalizing"];
const failed = ["failed", "interrupted", "timed_out"];
const waiting = ["waiting_permission", "draft"];
/** Run, workflow and step status as one compact tag. */
export function Status({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const Icon = moving.includes(status)
    ? Loader2
    : failed.includes(status)
      ? CircleAlert
      : status === "completed"
        ? Check
        : waiting.includes(status)
          ? Pause
          : Circle;
  return (
    <span
      className={cn(
        "tag",
        status === "completed" && "good",
        moving.includes(status) && "info",
        failed.includes(status) && "error",
        waiting.includes(status) && "warn",
        className,
      )}
    >
      <Icon
        className={cn("size-3", moving.includes(status) && "animate-spin")}
        strokeWidth={2}
      />
      {statusNames[status] ?? status}
    </span>
  );
}
