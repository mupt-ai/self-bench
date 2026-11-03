import { useState } from "react";
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
  return { activeId, rowId, highlighted, onActiveChange, onHighlightChange, onRowHover };
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
          <ResultsChart
            key={chartKey}
            settings={settings}
            onActiveChange={marks.onActiveChange}
            onHighlightChange={marks.onHighlightChange}
            selectedId={marks.rowId}
          />
        </div>
      </section>

      <section className="flex min-w-0 flex-col gap-3" data-morph="table" {...revealGroup}>
        <h2 className="text-sm font-medium">All Settings</h2>
        {note && <p className="text-sm text-muted-foreground">{note}</p>}
        <ModelTable
          settings={settings}
          activeId={marks.activeId ?? marks.rowId}
          highlighted={marks.highlighted}
          onRowHover={marks.onRowHover}
        />
      </section>
    </div>
  );
}
