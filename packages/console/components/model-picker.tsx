// SPDX-License-Identifier: MIT
import { useId, useMemo, useRef, useState } from "react";
import {
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Search,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { BrandIcon } from "@/components/brand-icon";
import {
  priceText,
  tokenCount,
  type GatewayModels,
  type ModelOption,
} from "@/lib/gateway-models";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** The list: sections filtered by the query, each option with window and price. */
function ModelList({
  models,
  value,
  query,
  active,
  onChoose,
  listId,
  none,
}: {
  models: GatewayModels;
  value: string | undefined;
  query: string;
  active: number;
  onChoose: (ref: string | undefined) => void;
  listId: string;
  none: string | undefined;
}) {
  const filtered = filterSections(models, query);
  // The clearing entry is offered only before the user starts searching.
  const clearing = none !== undefined && !query.trim();
  let index = clearing ? 0 : -1;
  return (
    <div
      id={listId}
      role="listbox"
      aria-label={t("agents.picker.models")}
      className="max-h-[min(420px,60vh)] overflow-y-auto p-1"
    >
      {clearing ? (
        <Option
          id={`${listId}-0`}
          active={active === 0}
          selected={value === undefined}
          onChoose={() => onChoose(undefined)}
        >
          <span className="text-muted-foreground">{none}</span>
        </Option>
      ) : null}
      {filtered.map((section) => (
        <div key={section.id} role="group" aria-label={section.title}>
          <div className="flex items-center gap-2 px-2 pt-2.5 pb-1 text-[12px] text-subtle">
            {section.id === "group" || section.id === "auto-group" ? null : (
              <BrandIcon
                slug={section.icon}
                name={section.title}
                className="size-4 rounded-[5px] text-[8px]"
              />
            )}
            {section.title}
          </div>
          {section.options.map((option) => {
            index += 1;
            const current = index;
            return (
              <Option
                key={option.ref}
                id={`${listId}-${current}`}
                active={active === current}
                selected={value === option.ref}
                onChoose={() => onChoose(option.ref)}
              >
                <OptionText option={option} />
              </Option>
            );
          })}
        </div>
      ))}
      {!filtered.length && !clearing ? (
        <p className="px-2 py-6 text-center text-[13px] text-muted-foreground">
          {models.sections.length
            ? t("agents.picker.noMatch")
            : t("agents.picker.noModels")}
        </p>
      ) : null}
    </div>
  );
}

function Option({
  id,
  active,
  selected,
  onChoose,
  children,
}: {
  id: string;
  active: boolean;
  selected: boolean;
  onChoose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="option"
      id={id}
      aria-selected={selected}
      data-active={active ? "true" : undefined}
      className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-accent data-[active=true]:bg-accent"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onChoose}
    >
      <span className="min-w-0 flex-1">{children}</span>
      {selected ? <Check className="size-4 shrink-0 text-brand" /> : null}
    </div>
  );
}

function OptionText({ option }: { option: ModelOption }) {
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <span className="truncate font-mono text-[12.5px]">{option.label}</span>
      <span className="text-[11.5px] text-subtle tabular">
        {option.members
          ? t("agents.picker.members", { n: option.members.length })
          : facts(option)}
      </span>
    </span>
  );
}

/** "128K context · $0.27 / $1.10"; parts that no source knows are left out. */
function facts(option: ModelOption): string {
  const parts = [
    ...(option.contextWindow !== undefined
      ? [
          t("agents.picker.context", {
            tokens: tokenCount(option.contextWindow),
          }),
        ]
      : []),
    ...(option.price ? [priceText(option.price)] : []),
  ];
  return parts.join(" · ") || t("agents.picker.factsUnknown");
}

function filterSections(models: GatewayModels, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return models.sections;
  return models.sections
    .map((section) => ({
      ...section,
      options: section.options.filter(
        (option) =>
          option.ref.toLowerCase().includes(needle) ||
          section.title.toLowerCase().includes(needle),
      ),
    }))
    .filter((section) => section.options.length);
}

/**
 * Choose one of the gateway's models: a searchable list grouped by provider,
 * with each model's context window and price (USD per million input and
 * output tokens), then route groups. `none` adds a first entry that clears
 * the choice (e.g. "follow the main model"). Arrow keys move, Enter chooses, Escape
 * closes. `variant="pill"` draws the trigger as a composer pill instead of a
 * form field.
 */
export function ModelPicker({
  models,
  value,
  onChange,
  none,
  label,
  disabled,
  className,
  variant = "field",
}: {
  models: GatewayModels;
  value: string | undefined;
  onChange: (ref: string | undefined) => void;
  none?: string;
  /** Accessible name of the trigger. */
  label: string;
  disabled?: boolean;
  className?: string;
  variant?: "field" | "pill";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const flat = useMemo(() => {
    const refs: Array<string | undefined> =
      none !== undefined && !query.trim() ? [undefined] : [];
    for (const section of filterSections(models, query))
      for (const option of section.options) refs.push(option.ref);
    return refs;
  }, [models, query, none]);
  const choose = (ref: string | undefined) => {
    onChange(ref);
    setOpen(false);
    setQuery("");
  };
  const current = value ? models.byRef.get(value) : undefined;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          setActive(Math.max(0, flat.indexOf(value)));
        }
      }}
    >
      <PopoverTrigger asChild>
        {variant === "pill" ? (
          <button
            type="button"
            disabled={disabled}
            aria-label={t("agents.picker.trigger", {
              label,
              value: value ?? none ?? t("agents.picker.unset"),
            })}
            title={value ?? none}
            className={cn("pill max-w-[220px]", className)}
          >
            <BrainCircuit className="size-[15px] shrink-0" strokeWidth={1.7} />
            <span className="truncate">
              {value ?? none ?? t("agents.picker.choose")}
            </span>
            {disabled ? null : (
              <ChevronDown className="size-3.5 shrink-0 opacity-60" />
            )}
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled}
            aria-label={t("agents.picker.trigger", {
              label,
              value: value ?? none ?? t("agents.picker.unset"),
            })}
            className={cn(
              "flex h-9 w-full min-w-0 items-center gap-2 rounded-[10px] border border-input bg-background px-3 text-left text-[13px] outline-none hover:border-border-strong focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50",
              className,
            )}
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
              {value ?? (
                <span className="font-sans text-subtle">
                  {none ?? t("agents.picker.choose")}
                </span>
              )}
            </span>
            {current?.contextWindow !== undefined ? (
              <span className="hidden shrink-0 text-[11.5px] text-subtle sm:inline">
                {tokenCount(current.contextWindow)}
              </span>
            ) : null}
            <ChevronsUpDown className="size-3.5 shrink-0 text-subtle" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(440px,calc(100vw-24px))] p-0"
        {...(variant === "pill" ? { side: "top" as const } : {})}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          input.current?.focus();
        }}
      >
        <label className="flex h-11 items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-subtle" />
          <input
            ref={input}
            className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-subtle"
            placeholder={t("agents.picker.searchPlaceholder")}
            aria-label={t("agents.picker.search")}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={`${listId}-${active}`}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((n) => Math.min(flat.length - 1, n + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((n) => Math.max(0, n - 1));
              } else if (event.key === "Enter" && flat.length) {
                event.preventDefault();
                choose(flat[active]);
              }
            }}
          />
        </label>
        <ModelList
          models={models}
          value={value}
          query={query}
          active={active}
          onChoose={choose}
          listId={listId}
          none={none}
        />
      </PopoverContent>
    </Popover>
  );
}
