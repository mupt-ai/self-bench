import { thinkingLevels } from "../../../../src/contracts/models";
import { type SortDirection, sortRows, useTableSort } from "../../lib/table-sort";
import type { PublicSetting } from "../contract";
import {
  dollars,
  harnessLabel,
  percent,
  reasoningLabel,
  settingLabel,
  vendorColor,
} from "../format";
import { AdaptiveTable, type Column } from "../mobile/AdaptiveTable";

type SortKey = "reasoning" | "accuracy" | "cost";

/** What each sortable column sorts by, and the way it sorts first. */
const SORTS: Record<SortKey, { value: (row: PublicSetting) => number; first: SortDirection }> = {
  // Reasoning levels in the catalog's order, from default and off up to max.
  reasoning: { value: (row) => thinkingLevels.indexOf(row.reasoningLevel), first: "desc" },
  accuracy: { value: (row) => row.accuracy, first: "desc" },
  cost: { value: (row) => row.costPerTaskUsd, first: "asc" },
};
const FIRST = Object.fromEntries(
  Object.entries(SORTS).map(([key, sort]) => [key, sort.first]),
) as Record<SortKey, SortDirection>;

/**
 * Every setting, most accurate first, with bars so the table reads as a chart too. Reasoning,
 * accuracy and cost sort from their headers. `activeId` and `highlighted` come from the chart:
 * the setting its pointer is on, and the settings of the vendor chip it highlights. A row the
 * pointer is on goes the other way, through `onRowHover`, to light up its point.
 */
export function ModelTable({
  settings,
  activeId = null,
  highlighted = null,
  onRowHover,
}: {
  settings: PublicSetting[];
  activeId?: string | null;
  highlighted?: ReadonlySet<string> | null;
  onRowHover?: (id: string | null) => void;
}) {
  const { sort, toggle } = useTableSort<SortKey>({ key: "accuracy", direction: "desc" }, FIRST);
  // Most accurate, then cheapest: the order settings that tie keep under any sort.
  const ranked = [...settings].sort(
    (left, right) => right.accuracy - left.accuracy || left.costPerTaskUsd - right.costPerTaskUsd,
  );
  const rows = sortRows(ranked, SORTS[sort.key].value, sort.direction);
  const maxCost = Math.max(...rows.map((row) => row.costPerTaskUsd), 0.01);
  const columns: Column<PublicSetting, SortKey>[] = [
    {
      header: "Model",
      role: "title",
      cell: (row) => (
        // Baselines line up, so the frontier tag sits on the name's line, not its middle.
        <span className="flex items-baseline gap-2 font-medium">
          <span className="size-2 shrink-0 self-center" style={{ background: vendorColor(row) }} />
          {settingLabel(row, settings)}
          {row.onFrontier && (
            <span
              className="font-mono text-[10px] text-muted-foreground compact:text-[11px]"
              title="On the Pareto frontier"
            >
              frontier
            </span>
          )}
        </span>
      ),
    },
    { header: "Harness", role: "detail", cell: harnessLabel },
    {
      header: "Reasoning",
      role: "detail",
      cell: reasoningLabel,
      sort: { key: "reasoning", first: SORTS.reasoning.first },
    },
    {
      header: "Accuracy",
      role: "metric",
      className: "w-48",
      cell: (row) => (
        <Bar value={row.accuracy / 100} label={percent(row.accuracy)} color="var(--foreground)" />
      ),
      sort: { key: "accuracy", first: SORTS.accuracy.first },
    },
    {
      header: "Cost / Task",
      role: "metric",
      className: "w-48",
      cell: (row) => (
        <Bar
          value={row.costPerTaskUsd / maxCost}
          label={dollars(row.costPerTaskUsd)}
          color="var(--muted-fg)"
        />
      ),
      sort: { key: "cost", first: SORTS.cost.first },
    },
  ];
  return (
    <AdaptiveTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      sort={sort}
      onSort={toggle}
      onRowHover={onRowHover && ((row) => onRowHover(row?.id ?? null))}
      rowClassName={(row) =>
        row.id === activeId
          ? "bg-(--row-mark)"
          : highlighted === null
            ? ""
            : highlighted.has(row.id)
              ? "bg-muted/50"
              : "opacity-45"
      }
    />
  );
}

function Bar({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <span className="flex items-center gap-2">
      {/* A see-through track, so a marked row's colour shows through it. */}
      <span className="h-1.5 flex-1 bg-foreground/5">
        <span
          className="block h-full"
          style={{ width: `${Math.max(2, value * 100)}%`, background: color, opacity: 0.7 }}
        />
      </span>
      <span className="w-14 text-right font-mono tabular-nums">{label}</span>
    </span>
  );
}
