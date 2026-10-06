import type { PublicSetting } from "../contract";
import { pageBody, revealGroup } from "../effects/marks";
import { PANEL } from "../frame";
import { ModelTable } from "./ModelTable";
import { ResultsChart } from "./ResultsChart";

/**
 * A release's chart and settings table, above one another or, on a wide window, side by side:
 * the heart of a repository's page and a group's alike. The chart's pointer and vendor chips mark
 * the same settings in the table, and the table row under the pointer lights up its point.
 */
export function SettingsResults({
  releaseId,
  settings,
  side,
  activeId,
  rowId,
  highlighted,
  onActiveChange,
  onHighlightChange,
  onRowHover,
}: {
  releaseId: string;
  settings: PublicSetting[];
  /** The chart beside the table, on a wide window, rather than above it. */
  side: boolean;
  activeId: string | null;
  rowId: string | null;
  highlighted: ReadonlySet<string> | null;
  onActiveChange: (id: string | null) => void;
  onHighlightChange: (ids: ReadonlySet<string> | null) => void;
  onRowHover: (id: string | null) => void;
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
        <h2 className="text-sm font-medium">Accuracy vs Cost per Task</h2>
        <div className={`p-2 ${PANEL}`}>
          <ResultsChart
            key={releaseId}
            settings={settings}
            onActiveChange={onActiveChange}
            onHighlightChange={onHighlightChange}
            selectedId={rowId}
          />
        </div>
      </section>

      <section className="flex min-w-0 flex-col gap-3" data-morph="table" {...revealGroup}>
        <h2 className="text-sm font-medium">All Settings</h2>
        <ModelTable
          settings={settings}
          activeId={activeId ?? rowId}
          highlighted={highlighted}
          onRowHover={onRowHover}
        />
      </section>
    </div>
  );
}
