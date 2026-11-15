import { useState } from "react";
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
        {/* A container, so the filters move into the chart's top corner once it is wide enough. */}
        <div className={`@container relative p-2 ${PANEL}`}>
          <SettingFilters
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

/**
 * Which values a page hides when it opens: routers, when it has plain models to show instead. A
 * page with no plain models shows what it has.
 */
function hiddenWhenOpened(settings: PublicSetting[]): Record<string, readonly string[]> {
  const kinds = new Set(settings.map(settingKind));
  return kinds.has("model") ? { Show: [...kinds].filter((kind) => kind !== "model") } : {};
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
 * Chips over the chart, in its panel: Show (Models, Routers), Harness (Default, Custom), and Tasks
 * (Original, Ablation). Each is a checkbox drawn as a chip, so it reads like the vendor chips the
 * plot draws, and a tap takes a finger.
 */
function SettingFilters({
  groups,
  hiddenOf,
  toggle,
}: Pick<ReturnType<typeof useSettingFilters>, "groups" | "hiddenOf" | "toggle">) {
  if (groups.length === 0) return null;
  return (
    // Above the chart, or in its top corner, where the settings button sits, once the chart is
    // wide enough for them beside its vendor chips (a container query on the panel).
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 px-1 @min-[60rem]:absolute @min-[60rem]:top-3 @min-[60rem]:right-10 @min-[60rem]:z-10 @min-[60rem]:mb-0 @min-[60rem]:justify-end">
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
