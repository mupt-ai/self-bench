import type { PublicSetting } from "../contract";
import {
  accessLabel,
  dollars,
  harnessLabel,
  percent,
  reasoningLabel,
  settingLabel,
  vendorColor,
} from "../format";
import { AdaptiveTable, type Column } from "../mobile/AdaptiveTable";

/** Every setting, most accurate first, with bars so the table reads as a chart too. */
export function ModelTable({ settings }: { settings: PublicSetting[] }) {
  const rows = [...settings].sort(
    (left, right) => right.accuracy - left.accuracy || left.costPerTaskUsd - right.costPerTaskUsd,
  );
  const maxCost = Math.max(...rows.map((row) => row.costPerTaskUsd), 0.01);
  const columns: Column<PublicSetting>[] = [
    {
      header: "Model",
      role: "title",
      cell: (row) => (
        <span className="flex items-center gap-2 font-medium">
          <span className="size-2 shrink-0" style={{ background: vendorColor(row) }} />
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
    { header: "Reasoning", role: "detail", cell: reasoningLabel },
    { header: "Access", role: "detail", cell: accessLabel },
    {
      header: "Accuracy",
      role: "metric",
      className: "w-48",
      cell: (row) => (
        <Bar value={row.accuracy / 100} label={percent(row.accuracy)} color="var(--foreground)" />
      ),
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
    },
  ];
  return <AdaptiveTable columns={columns} rows={rows} rowKey={(row) => row.id} />;
}

function Bar({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 flex-1 bg-muted">
        <span
          className="block h-full"
          style={{ width: `${Math.max(2, value * 100)}%`, background: color, opacity: 0.7 }}
        />
      </span>
      <span className="w-14 text-right font-mono tabular-nums">{label}</span>
    </span>
  );
}
