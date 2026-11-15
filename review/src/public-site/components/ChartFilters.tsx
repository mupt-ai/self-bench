import { SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SETTING_KINDS, settingKind } from "../../../../src/public/setting-kinds";
import type { PublicSetting } from "../contract";
import { PANEL } from "../frame";

interface Option<T extends string> {
  value: T;
  label: string;
}

/** One filter: a chip group, the setting's value under it, and the options it can take. */
interface FilterGroup {
  label: string;
  options: Option<string>[];
  value: (setting: PublicSetting) => string;
}

const harnessKind = (setting: PublicSetting) => (setting.customHarness ? "custom" : "default");
const taskKind = (setting: PublicSetting) => (setting.ablation ? "ablation" : "original");

const GROUPS: FilterGroup[] = [
  {
    label: "Show",
    options: SETTING_KINDS.map(({ kind, label }) => ({ value: kind, label })),
    value: settingKind,
  },
  {
    label: "Harness",
    options: [
      { value: "default", label: "Default" },
      { value: "custom", label: "Custom" },
    ],
    value: harnessKind,
  },
  {
    label: "Tasks",
    options: [
      { value: "original", label: "Original" },
      { value: "ablation", label: "Ablation" },
    ],
    value: taskKind,
  },
];

/** What each filter opens with: its default value alone, the one the page leads with. */
const DEFAULT_VALUE: Record<string, string> = {
  Show: "model",
  Harness: "default",
  Tasks: "original",
};

/**
 * What a page hides when it opens: every value but its default, in each filter whose default it
 * has (plain models, the harness as it ships, the tasks as they are). A page without a default
 * shows all of that filter's values.
 */
function hiddenWhenOpened(settings: PublicSetting[]): Record<string, readonly string[]> {
  return Object.fromEntries(
    GROUPS.flatMap((group) => {
      const fallback = DEFAULT_VALUE[group.label];
      const values = [...new Set(settings.map(group.value))];
      if (fallback === undefined || !values.includes(fallback)) return [];
      return [[group.label, values.filter((value) => value !== fallback)]];
    }),
  );
}

/** The filters' state: what each group hides, with the groups this page has. */
export function useSettingFilters(settings: PublicSetting[], release: string) {
  // The groups a page has more than one value of: a filter over one value filters nothing.
  const groups = GROUPS.map((group) => ({
    ...group,
    options: group.options.filter((option) =>
      settings.some((setting) => group.value(setting) === option.value),
    ),
  })).filter((group) => group.options.length > 1);
  // Another release (`release`) starts the filters afresh, since its values differ.
  const [stored, setStored] = useState(() => ({ release, hidden: hiddenWhenOpened(settings) }));
  const current =
    stored.release === release ? stored : { release, hidden: hiddenWhenOpened(settings) };
  const hiddenOf = (label: string): ReadonlySet<string> => new Set(current.hidden[label] ?? []);
  return {
    groups,
    hiddenOf,
    toggle: (label: string, value: string) =>
      setStored({
        release,
        hidden: {
          ...current.hidden,
          [label]: [...toggled(hiddenOf(label), value)],
        },
      }),
    shows: (setting: PublicSetting) =>
      GROUPS.every((group) => !hiddenOf(group.label).has(group.value(setting))),
    filterKey: Object.entries(current.hidden)
      .map(([label, values]) => `${label}:${values.join(",")}`)
      .join("|"),
  };
}

function toggled(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

/**
 * The chart's filters: a sliders button in its top-right corner, which opens a panel with the
 * chips (Show, Harness, Tasks). It replaces the plot's own settings button, whose text size the
 * page does not offer. A tap takes a finger; Escape or a tap outside closes the panel.
 */
export function ChartFilters({
  groups,
  hiddenOf,
  toggle,
}: Pick<ReturnType<typeof useSettingFilters>, "groups" | "hiddenOf" | "toggle">) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (groups.length === 0) return null;
  return (
    <div ref={root} className="absolute top-2 right-2 z-20">
      <button
        type="button"
        aria-label="Filters"
        aria-expanded={open}
        aria-controls="chart-filters"
        onClick={() => setOpen((current) => !current)}
        className={`hit relative grid size-7 place-items-center border text-muted-foreground transition-colors hover:text-foreground touch:size-11 ${
          open ? "border-foreground/40 text-foreground" : "border-transparent"
        }`}
      >
        <SlidersHorizontal aria-hidden size={16} strokeWidth={1.75} />
      </button>
      {open && (
        <div
          id="chart-filters"
          className={`absolute top-9 right-0 flex w-max max-w-[calc(100vw-3rem)] flex-col gap-3 p-3 ${PANEL}`}
        >
          {groups.map((group) => (
            <ChipGroup
              key={group.label}
              label={group.label}
              options={group.options}
              hidden={hiddenOf(group.label)}
              onToggle={(value) => toggle(group.label, value)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChipGroup({
  label,
  options,
  hidden,
  onToggle,
}: {
  label: string;
  options: Option<string>[];
  hidden: ReadonlySet<string>;
  onToggle: (value: string) => void;
}) {
  return (
    <fieldset aria-label={label} className="flex min-w-0 flex-wrap items-center gap-1.5">
      <legend className="float-left mr-1 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </legend>
      {options.map((option) => {
        const on = !hidden.has(option.value);
        return (
          <label
            key={option.value}
            className={`hit relative inline-flex cursor-pointer items-center gap-1.5 border px-2 py-0.5 text-xs transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-(--foreground) touch:min-h-11 ${
              on
                ? "border-foreground/40 bg-foreground/5 text-foreground"
                : "border-border text-muted-foreground"
            }`}
          >
            <input
              type="checkbox"
              className="sr-only"
              checked={on}
              onChange={() => onToggle(option.value)}
            />
            <span
              aria-hidden
              className={`size-2 shrink-0 border ${on ? "border-foreground bg-foreground" : "border-muted-foreground"}`}
            />
            {option.label}
          </label>
        );
      })}
    </fieldset>
  );
}
