import { picks } from "./directory.js";
import type { PublishedLine } from "./release-types.js";

/**
 * What search engines and link previews read about selfbench.dev: each page's title and
 * description. The server writes them into the HTML it sends, and the site sets the same title
 * as the reader moves between pages, so the two never disagree. The name is written "SelfBench",
 * one word, the way people search for it.
 */

export const SITE_NAME = "SelfBench";

export const HOME_TITLE = "SelfBench: Benchmark Coding Agents on Your Own Repository";

export const HOME_DESCRIPTION =
  "SelfBench measures AI coding agents and models on tasks from a repository's own merged pull requests, to show which works best on your code. By dari.dev.";

export function repositoryTitle(fullName: string): string {
  return `${fullName}: Coding Agent Benchmark · ${SITE_NAME}`;
}

/**
 * The line a repository page shows by default: its endorsed line, else its newest. The same rule
 * as the directory's (`directoryOf`).
 */
export function defaultLineOf(lines: readonly PublishedLine[]): PublishedLine | undefined {
  const newest = [...lines].sort(
    (left, right) =>
      right.release.releasedAt.localeCompare(left.release.releasedAt) ||
      left.release.releaseId.localeCompare(right.release.releaseId),
  );
  return newest.find((line) => line.endorsed) ?? newest[0];
}

const percent = (value: number) => `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
const dollars = (value: number) => `$${value.toFixed(value < 0.1 ? 3 : 2)}`;

/**
 * A repository page's description: the two settings its cards name, then what was measured.
 * Search results show only the first 150 or so characters, so the picks come first.
 */
export function repositoryDescription(line: PublishedLine): string {
  const { release } = line;
  const { fullName } = release.repository;
  const chosen = picks(release.settings);
  const best = chosen.find((pick) => pick.roles.includes("mostAccurate"))?.setting;
  const cheapest = chosen.find((pick) => pick.roles.includes("cheapest"))?.setting;
  const settings = release.settings.length;
  return [
    `Which coding agent works best on ${fullName}?`,
    best ? `Most accurate: ${best.model.label}, ${percent(best.accuracy)}.` : "",
    cheapest && cheapest !== best
      ? `Cheapest: ${cheapest.model.label}, ${dollars(cheapest.costPerTaskUsd)} per task.`
      : "",
    `${settings} model ${settings === 1 ? "setting" : "settings"} scored on ${release.tasks} ${release.tasks === 1 ? "task" : "tasks"} from its merged pull requests.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The site's identity for search engines, on the home page: its name, as a WebSite, so results
 * show "SelfBench" rather than the domain, and who makes it.
 */
export function siteStructuredData(origin: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${origin}/#website`,
        name: SITE_NAME,
        alternateName: ["Self-Bench", "selfbench.dev"],
        url: `${origin}/`,
        publisher: { "@id": "https://dari.dev/#organization" },
      },
      {
        "@type": "Organization",
        "@id": "https://dari.dev/#organization",
        name: "Dari",
        url: "https://dari.dev",
        logo: `${origin}/icon-192.png`,
      },
    ],
  };
}
