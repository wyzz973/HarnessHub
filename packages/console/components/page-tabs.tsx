// SPDX-License-Identifier: MIT
import { navigate, type Page } from "@/lib/router";
import { cn } from "@/lib/utils";

/**
 * Sibling pages of one section, as tabs above the page title. Each tab is
 * its own address, so it can be reloaded and bookmarked.
 */
export function PageTabs({
  label,
  current,
  tabs,
}: {
  label: string;
  current: Page;
  tabs: ReadonlyArray<{ page: Page; label: string }>;
}) {
  return (
    <nav
      aria-label={label}
      className="mb-5 flex gap-1 overflow-x-auto border-b"
    >
      {tabs.map((tab) => (
        <button
          key={tab.page}
          type="button"
          aria-current={tab.page === current ? "page" : undefined}
          className={cn(
            "-mb-px h-9 shrink-0 border-b-2 border-transparent px-3 text-[13.5px] text-muted-foreground hover:text-foreground",
            tab.page === current && "border-brand font-medium text-foreground",
          )}
          onClick={() => navigate(tab.page)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
