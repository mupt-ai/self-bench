import type { PublicPick, PublicSetting } from "../contract";
import { dollars, harnessLabel, percent, ROLE_LABELS, settingLabel, vendorColor } from "../format";
import { PANEL } from "../frame";

/** The two frontier picks: cheapest and most accurate. */
export function Picks({
  picks,
  settings,
  compact = false,
}: {
  picks: PublicPick[];
  /** All settings of the release, so twins get distinct names. */
  settings?: PublicSetting[];
  compact?: boolean;
}) {
  const name = (setting: PublicSetting) =>
    settings ? settingLabel(setting, settings) : setting.model.label;
  const columns =
    ["", "sm:grid-cols-1", "sm:grid-cols-2", "sm:grid-cols-3"][picks.length] ?? "sm:grid-cols-2";
  if (compact) {
    return (
      <ul className="flex flex-col gap-1.5">
        {picks.map((pick) => (
          <li key={pick.setting.id} className="flex items-baseline gap-2 text-xs">
            <span className="w-24 shrink-0 text-foreground/70">
              {pick.roles.map((role) => ROLE_LABELS[role]).join(" · ")}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">{name(pick.setting)}</span>
            <span className="shrink-0 font-mono tabular-nums">
              {percent(pick.setting.accuracy)}
            </span>
            <span className="w-14 shrink-0 text-right font-mono tabular-nums text-muted-foreground">
              {dollars(pick.setting.costPerTaskUsd)}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className={`grid gap-px bg-border ${columns} ${PANEL}`}>
      {picks.map((pick) => (
        <li key={pick.setting.id} className="flex flex-col gap-2 bg-card p-4">
          <span className="text-xs text-muted-foreground">
            {pick.roles.map((role) => ROLE_LABELS[role]).join(" · ")}
          </span>
          <span className="flex items-center gap-2 font-medium">
            <span
              className="size-2 shrink-0"
              style={{ background: vendorColor(pick.setting) }}
              aria-hidden="true"
            />
            {name(pick.setting)}
          </span>
          <span className="text-xs text-muted-foreground">
            {harnessLabel(pick.setting)} · {pick.setting.reasoningLevel}
          </span>
          <span className="flex items-baseline gap-4 font-mono tabular-nums">
            <span className="text-lg">{percent(pick.setting.accuracy)}</span>
            <span className="text-muted-foreground">
              {dollars(pick.setting.costPerTaskUsd)} / task
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
