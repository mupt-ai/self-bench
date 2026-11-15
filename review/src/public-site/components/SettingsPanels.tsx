import { useState } from "react";
import { SETTING_KINDS, type SettingKind, settingKind } from "../../../../src/public/setting-kinds";
import type { PublicSetting } from "../contract";
import { pageBody, revealGroup } from "../effects/marks";
import { harnessLabel } from "../format";
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
  const filters = useSettingFilters(settings);
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
        <SettingFilters {...filters} />
        <div className={`p-2 ${PANEL}`}>
          <ResultsChart
            key={`${chartKey}:${filters.key}`}
            settings={shown}
            onActiveChange={marks.onActiveChange}
            onHighlightChange={marks.onHighlightChange}
            selectedId={marks.rowId}
          />
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

/** The filters' state: which kinds and harnesses show, with the options this page has. */
function useSettingFilters(settings: PublicSetting[]) {
  const kinds: Option<SettingKind>[] = SETTING_KINDS.filter(({ kind }) =>
    settings.some((setting) => settingKind(setting) === kind),
  ).map(({ kind, label }) => ({ value: kind, label }));
  const harnesses: Option<string>[] = [...new Set(settings.map((setting) => setting.harness))]
    .sort()
    .map((harness) => ({
      value: harness,
      label: harnessLabel({ harness } as PublicSetting),
    }));
  // Models first, as the page opens; a page with no plain models shows what it has.
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<string>>(() =>
    kinds.some(({ value }) => value === "model")
      ? new Set(kinds.flatMap(({ value }) => (value === "model" ? [] : [value])))
      : new Set(),
  );
  const [hiddenHarnesses, setHiddenHarnesses] = useState<ReadonlySet<string>>(new Set());
  return {
    kinds,
    harnesses,
    hiddenKinds,
    hiddenHarnesses,
    toggleKind: (value: string) => setHiddenKinds((hidden) => toggled(hidden, value)),
    toggleHarness: (value: string) => setHiddenHarnesses((hidden) => toggled(hidden, value)),
    shows: (setting: PublicSetting) =>
      !hiddenKinds.has(settingKind(setting)) && !hiddenHarnesses.has(setting.harness),
    key: [...hiddenKinds, "|", ...hiddenHarnesses].join(","),
  };
}

function toggled(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

/** Checkboxes over the chart and table: kinds (Models, Routers) and harnesses. */
function SettingFilters({
  kinds,
  harnesses,
  hiddenKinds,
  hiddenHarnesses,
  toggleKind,
  toggleHarness,
}: ReturnType<typeof useSettingFilters>) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
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
    <fieldset aria-label={label} className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
      <legend className="float-left mr-1 text-xs text-muted-foreground compact:text-[11px]">
        {label}
      </legend>
      {options.map((option) => (
        <label
          key={option.value}
          className="hit relative flex cursor-pointer items-center gap-1.5 text-sm"
        >
          <input
            type="checkbox"
            className="accent-(--foreground)"
            checked={!hidden.has(option.value)}
            onChange={() => onToggle(option.value)}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
