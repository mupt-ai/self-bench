import { SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SETTING_KINDS, settingKind } from "../../../../src/public/setting-kinds";
import type { PublicSetting } from "../contract";
import { pageBody, revealGroup } from "../effects/marks";
import { PANEL } from "../frame";
import { ModelTable } from "./ModelTable";
import { ResultsChart } from "./ResultsChart";

/** Which settings the chart and the table mark, as they mark them for each other. */
export interface SettingMarks {
  /** The setting the chart's pointer is on. */
  activeId: string | null;
  /** The table row under the pointer, which lights up its point. */
  rowId: string | null;
  /** The settings of the vendor chip the chart highlights. */
  highlighted: ReadonlySet<string> | null;
  onActiveChange: (id: string | null) => void;
  onHighlightChange: (ids: ReadonlySet<string> | null) => void;
  onRowHover: (id: string | null) => void;
}

/** Marks that start clear, for a page showing one set of settings. */
export function useSettingMarks(): SettingMarks {
  const [activeId, onActiveChange] = useState<string | null>(null);
  const [highlighted, onHighlightChange] = useState<ReadonlySet<string> | null>(null);
  const [rowId, onRowHover] = useState<string | null>(null);
  return {
    activeId,
    rowId,
    highlighted,
    onActiveChange,
    onHighlightChange,
    onRowHover,
  };
}

/**
 * The results of a set of settings: the accuracy-against-cost chart and every setting's row, each
 * marking what the other points at. A repository page and a group page show them alike.
 */
export function SettingsPanels({
  settings,
  chartKey,
  side = false,
  note,
  ...marks
}: SettingMarks & {
  settings: PublicSetting[];
  /** Starts the chart afresh when it changes: another release's settings. */
  chartKey: string;
  /** The chart beside the table, on a wide window, rather than above it. */
  side?: boolean;
  /** A line under the table's heading. */
  note?: string;
}) {
  const filters = useSettingFilters(settings, chartKey);
  const shown = settings.filter(filters.shows);
  return (
    // Side by side, the chart stays in view while the table scrolls past it.
    <div
      {...pageBody}
      className={`flex flex-col gap-8 ${
        side
          ? "min-[90rem]:grid min-[90rem]:grid-cols-[minmax(420px,2fr)_minmax(720px,3fr)] min-[90rem]:items-start min-[90rem]:gap-6"
          : ""
      }`}
    >
      <section
        {...revealGroup}
        data-morph="chart"
        // min-w-0: side by side, each column keeps to its grid track, whatever its content.
        className={`flex min-w-0 flex-col gap-3 ${side ? "min-[90rem]:sticky min-[90rem]:top-[calc(var(--bar-top)_+_1rem)]" : ""}`}
      >
        <h2 className="text-base font-medium">Model Tradeoffs</h2>
        <div className={`relative p-2 ${PANEL}`}>
          <ChartFilters
            groups={filters.groups}
            hiddenOf={filters.hiddenOf}
            toggle={filters.toggle}
          />
          {shown.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">No settings match these filters.</p>
          ) : (
            <ResultsChart
              key={`${chartKey}:${filters.filterKey}`}
              settings={shown}
              onActiveChange={marks.onActiveChange}
              onHighlightChange={marks.onHighlightChange}
              selectedId={marks.rowId}
            />
          )}
        </div>
      </section>

      <section className="flex min-w-0 flex-col gap-3" data-morph="table" {...revealGroup}>
        <h2 className="text-sm font-medium">All Settings</h2>
        {note && <p className="text-sm text-muted-foreground">{note}</p>}
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">No settings match these filters.</p>
        ) : (
          <ModelTable
            settings={shown}
            activeId={marks.activeId ?? marks.rowId}
            highlighted={marks.highlighted}
            onRowHover={marks.onRowHover}
          />
        )}
      </section>
    </div>
  );
}

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
function useSettingFilters(settings: PublicSetting[], release: string) {
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
function ChartFilters({
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
