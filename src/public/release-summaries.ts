import type { ModelSummaryReport } from "../evaluation/model-summary.js";
import type { Candidate } from "./release-rule.js";
import type { ReleaseModelSummaries } from "./release-types.js";

/**
 * The report's sections on the chosen settings, by setting id, and its overview when every
 * setting it compared is chosen; undefined when it covers none of them.
 */
export function summariesFor(
  report: ModelSummaryReport,
  chosen: readonly Candidate[],
): ReleaseModelSummaries | undefined {
  const idOf = new Map(chosen.map((entry) => [entry.setting.key, entry.setting.id]));
  const settings = Object.fromEntries(
    report.summaries.flatMap((summary) => {
      const id = idOf.get(summary.configuration);
      return id ? [[id, summary.text]] : [];
    }),
  );
  if (!Object.keys(settings).length) return undefined;
  const whole = report.summaries.every((summary) => idOf.has(summary.configuration));
  return {
    ...(whole && report.overview ? { overview: report.overview } : {}),
    settings,
    model: report.model,
    summarizedAt: report.summarizedAt,
  };
}
