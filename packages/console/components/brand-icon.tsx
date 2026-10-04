// SPDX-License-Identifier: MIT
import { brandIcon } from "@/lib/brand-icons";
import { cn } from "@/lib/utils";

/** Up to two letters of a name: initials of its words, else its first letters. */
function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const letters =
    words.length > 1
      ? `${words[0]![0]}${words[1]![0]}`
      : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/**
 * The mark of a provider or agent from the bundled set, or its initials in
 * a tile when none is bundled. Decorative: the name is always shown beside it.
 */
export function BrandIcon({
  slug,
  name,
  className,
}: {
  slug: string | undefined;
  name: string;
  className?: string;
}) {
  const icon = brandIcon(slug);
  return (
    <span
      className={cn(
        "grid size-8 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-muted text-[11px] font-semibold text-muted-foreground",
        className,
      )}
      aria-hidden
    >
      {icon ? (
        <img
          src={icon.url}
          alt=""
          className={cn("size-[62%]", icon.mono && "dark:invert")}
          draggable={false}
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}
