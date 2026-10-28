import type { PublicRelease } from "../contract";
import { revealGroup } from "../effects/marks";
import { harnessLabel, reasoningLabel, settingLabel, vendorColor } from "../format";
import { PANEL } from "../frame";

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * The Model Summaries the publisher released: what the settings share, then each covered
 * setting's own section, most accurate first as the table starts, and who wrote them and when.
 */
export function ModelSummaries({
  release,
  activeId,
}: {
  release: PublicRelease;
  /** The setting the chart's or table's pointer is on, marked here too. */
  activeId: string | null;
}) {
  const summaries = release.modelSummaries;
  if (!summaries) return null;
  const covered = [...release.settings]
    .sort(
      (left, right) => right.accuracy - left.accuracy || left.costPerTaskUsd - right.costPerTaskUsd,
    )
    .flatMap((setting) => {
      const text = summaries.settings[setting.id];
      return text ? [{ setting, text }] : [];
    });
  return (
    <section className="flex min-w-0 flex-col gap-3" data-morph="summaries" {...revealGroup}>
      <h2 className="text-sm font-medium">Model Summaries</h2>
      {summaries.overview && (
        <p className="text-sm leading-6 text-muted-foreground">{summaries.overview}</p>
      )}
      <ul className={`divide-y divide-border ${PANEL}`}>
        {covered.map(({ setting, text }) => (
          <li
            key={setting.id}
            className={`grid min-w-0 grid-cols-1 gap-x-6 gap-y-1.5 px-3 py-3 md:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)] ${
              setting.id === activeId ? "bg-(--row-mark)" : ""
            }`}
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-baseline gap-2 text-sm font-medium">
                <span
                  className="size-2 shrink-0 self-center"
                  style={{ background: vendorColor(setting) }}
                />
                <span className="min-w-0 wrap-anywhere">
                  {settingLabel(setting, release.settings)}
                </span>
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {harnessLabel(setting)} · {reasoningLabel(setting)}
              </span>
            </span>
            <p className="min-w-0 text-sm leading-6">{text}</p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Written by {summaries.model} from these results on{" "}
        {day.format(new Date(summaries.summarizedAt))}.
      </p>
    </section>
  );
}
