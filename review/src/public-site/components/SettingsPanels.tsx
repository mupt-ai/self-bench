import { useState } from "react";
import { SETTING_KINDS, type SettingKind, settingKind } from "../../../../src/public/setting-kinds";
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
        <div className={`p-2 ${PANEL}`}>
          <SettingFilters
            kinds={filters.kinds}
            harnesses={filters.harnesses}
            hiddenKinds={filters.hiddenKinds}
            hiddenHarnesses={filters.hiddenHarnesses}
            toggleKind={filters.toggleKind}
            toggleHarness={filters.toggleHarness}
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

const HARNESS_KINDS: Option<string>[] = [
  { value: "default", label: "Default" },
  { value: "custom", label: "Custom" },
];

const harnessKind = (setting: PublicSetting) => (setting.customHarness ? "custom" : "default");

interface Option<T extends string> {
  value: T;
  label: string;
}

/** The filters' state: which kinds, and which harnesses (default or saved), show, with the options this page has. */
function useSettingFilters(settings: PublicSetting[], release: string) {
  const kinds: Option<SettingKind>[] = SETTING_KINDS.filter(({ kind }) =>
    settings.some((setting) => settingKind(setting) === kind),
  ).map(({ kind, label }) => ({ value: kind, label }));
  // The harness as it ships, or one of the publisher's saved harnesses.
  const harnesses: Option<string>[] = HARNESS_KINDS.filter(({ value }) =>
    settings.some((setting) => harnessKind(setting) === value),
  );
  // Models first, as the page opens; a page with no plain models shows what it has. Another
  // release (`release`) starts the filters afresh, since its kinds and harnesses differ.
  const fresh = () => ({
    release,
    kinds: new Set<string>(
      kinds.some(({ value }) => value === "model")
        ? kinds.flatMap(({ value }) => (value === "model" ? [] : [value]))
        : [],
    ) as ReadonlySet<string>,
    harnesses: new Set<string>() as ReadonlySet<string>,
  });
  const [stored, setStored] = useState(fresh);
  const hidden = stored.release === release ? stored : fresh();
  const hiddenKinds = hidden.kinds;
  const hiddenHarnesses = hidden.harnesses;
  return {
    kinds,
    harnesses,
    hiddenKinds,
    hiddenHarnesses,
    toggleKind: (value: string) => setStored({ ...hidden, kinds: toggled(hiddenKinds, value) }),
    toggleHarness: (value: string) =>
      setStored({ ...hidden, harnesses: toggled(hiddenHarnesses, value) }),
    shows: (setting: PublicSetting) =>
      !hiddenKinds.has(settingKind(setting)) && !hiddenHarnesses.has(harnessKind(setting)),
    filterKey: [...hiddenKinds, "|", ...hiddenHarnesses].join(","),
  };
}

function toggled(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

/**
 * Chips over the chart, in its panel: kinds (Models, Routers) and harnesses (Default, Custom). Each is a checkbox
 * drawn as a chip, so it reads like the vendor chips the plot draws, and a tap takes a finger.
 */
function SettingFilters({
  kinds,
  harnesses,
  hiddenKinds,
  hiddenHarnesses,
  toggleKind,
  toggleHarness,
}: Omit<ReturnType<typeof useSettingFilters>, "shows" | "filterKey">) {
  if (kinds.length < 2 && harnesses.length < 2) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
      {kinds.length > 1 && (
        <FilterGroup label="Show" options={kinds} hidden={hiddenKinds} onToggle={toggleKind} />
      )}
      {harnesses.length > 1 && (
        <FilterGroup
          label="Harness"
          options={harnesses}
          hidden={hiddenHarnesses}
          onToggle={toggleHarness}
        />
      )}
    </div>
  );
}

function FilterGroup({
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
