import type { PublicPick, PublicSetting } from "../contract";
import { dollars, harnessLabel, percent, ROLE_LABELS, settingLabel, vendorColor } from "../format";
import { PANEL } from "../frame";

/** The two frontier picks of a repository page: cheapest and most accurate. */
export function Picks({
  picks,
  settings,
}: {
  picks: PublicPick[];
  /** All settings of the release, so twins get distinct names. */
  settings?: PublicSetting[];
}) {
  const name = (setting: PublicSetting) =>
    settings ? settingLabel(setting, settings) : setting.model.label;
  const columns =
    ["", "sm:grid-cols-1", "sm:grid-cols-2", "sm:grid-cols-3"][picks.length] ?? "sm:grid-cols-2";
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
