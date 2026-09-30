import { frontierSettings } from "./directory.js";
import type { PublishedLine, ReleaseSetting } from "./release-types.js";

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
const scored = (setting: ReleaseSetting) =>
  `${percent(setting.accuracy)} at ${dollars(setting.costPerTaskUsd)}`;

/** A setting's model, with its effort when `other` is the same model at another effort. */
function nameBeside(setting: ReleaseSetting, other?: ReleaseSetting): string {
  const { label } = setting.model;
  const level = setting.reasoningLevel;
  if (!other || other.model.label !== label || other.reasoningLevel === level) return label;
  return `${label} (${level === "xhigh" ? "X-High" : level.charAt(0).toUpperCase() + level.slice(1)})`;
}

/**
 * A repository page's description: its most accurate setting and the best one for less (the next
 * on the frontier: the most accurate of the settings that cost less), then what was measured.
 * Search results show only the first 150 or so characters, so the picks come first.
 */
export function repositoryDescription(line: PublishedLine): string {
  const { release } = line;
  const [best, next] = frontierSettings(release.settings).sort(
    (left, right) =>
      right.accuracy - left.accuracy ||
      left.costPerTaskUsd - right.costPerTaskUsd ||
      left.id.localeCompare(right.id),
  );
  const settings = release.settings.length;
  return [
    `Which coding agent works best on ${release.repository.fullName}?`,
    best ? `Most accurate: ${nameBeside(best, next)}, ${scored(best)} per task.` : "",
    next ? `Best for less: ${nameBeside(next, best)}, ${scored(next)}.` : "",
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
