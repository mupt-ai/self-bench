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
import { PANEL } from "../frame";

/** Every setting, most accurate first, with bars so the table reads as a chart too. */
export function ModelTable({ settings }: { settings: PublicSetting[] }) {
  const rows = [...settings].sort(
    (left, right) => right.accuracy - left.accuracy || left.costPerTaskUsd - right.costPerTaskUsd,
  );
  const maxCost = Math.max(...rows.map((row) => row.costPerTaskUsd), 0.01);
  return (
    <div className={`overflow-x-auto ${PANEL}`}>
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-muted text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="px-3 py-2 font-medium">Harness</th>
            <th className="px-3 py-2 font-medium">Reasoning</th>
            <th className="px-3 py-2 font-medium">Access</th>
            <th className="w-48 px-3 py-2 font-medium">Accuracy</th>
            <th className="w-48 px-3 py-2 font-medium">Cost / Task</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-border last:border-b-0 hover:bg-muted/60">
              <td className="px-3 py-2">
                <span className="flex items-center gap-2 font-medium">
                  <span className="size-2 shrink-0" style={{ background: vendorColor(row) }} />
                  {settingLabel(row, settings)}
                  {row.onFrontier && (
                    <span
                      className="font-mono text-[10px] text-muted-foreground"
                      title="On the Pareto frontier"
                    >
                      frontier
                    </span>
                  )}
                </span>
              </td>
              <td className="px-3 py-2 text-muted-foreground">{harnessLabel(row)}</td>
              <td className="px-3 py-2 text-muted-foreground">{reasoningLabel(row)}</td>
              <td className="px-3 py-2 text-muted-foreground">{accessLabel(row)}</td>
              <td className="px-3 py-2">
                <Bar
                  value={row.accuracy / 100}
                  label={percent(row.accuracy)}
                  color="var(--foreground)"
                />
              </td>
              <td className="px-3 py-2">
                <Bar
                  value={row.costPerTaskUsd / maxCost}
                  label={dollars(row.costPerTaskUsd)}
                  color="var(--muted-fg)"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
