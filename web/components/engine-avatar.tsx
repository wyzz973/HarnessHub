import { Sparkles } from "lucide-react";
import { engineHue, engineMonogram } from "@/lib/engines";
import { cn } from "@/lib/utils";

const sizes = {
  xs: "size-5 rounded-[6px] text-[9.5px]",
  sm: "size-6 rounded-lg text-[10.5px]",
  md: "size-9 rounded-[11px] text-[13px]",
} as const;
/**
 * Monogram on a tint derived from the engine id. `auto` is the automatic
 * engine choice and gets a neutral mark instead of a letter.
 */
export function EngineAvatar({
  id,
  size = "sm",
  className,
}: {
  id: string;
  size?: keyof typeof sizes;
  className?: string;
}) {
  if (id === "auto")
    return (
      <span
        aria-hidden
        className={cn(
          "grid shrink-0 place-items-center bg-muted text-muted-foreground",
          sizes[size],
          className,
        )}
      >
        <Sparkles className="size-[60%]" strokeWidth={1.8} />
      </span>
    );
  const hue = engineHue(id);
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center font-semibold tracking-tight select-none",
        sizes[size],
        className,
      )}
      style={{
        background: `oklch(var(--avatar-l, 0.93) 0.045 ${hue})`,
        color: `oklch(var(--avatar-ink, 0.38) 0.09 ${hue})`,
      }}
    >
      {engineMonogram(id)}
    </span>
  );
}
