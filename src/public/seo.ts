import { isEvalName } from "../contracts/evals.js";
import { frontierSettings } from "./directory.js";
import type { PublishedGroup } from "./release-groups.js";
import type { PublishedLine, ReleaseSetting } from "./release-types.js";

/**
 * What search engines and link previews read about selfbench.dev: each page's title and
 * description. The server writes them into the HTML it sends, and the site sets the same title
 * as the reader moves between pages, so the two never disagree. The name is written "SelfBench",
 * one word, the way people search for it.
 */

export const SITE_NAME = "SelfBench";

const HOME_TITLE = "SelfBench: Benchmark Coding Agents on Your Own Repository";

/**
 * Written with a typographic apostrophe (’): some search engines show an ASCII one in a
 * description as the entity &#39;.
 */
export const HOME_DESCRIPTION =
  "SelfBench measures AI coding agents and models on tasks from a repository’s own merged pull requests, to show which works best on your code. By dari.dev.";

/** The home page's heading, which the server also writes for readers that run no scripts. */
export const HOME_HEADING = "Find the best models for your repo";

/**
 * The directory's two views, each a page of its own: repositories and their groups at `/`, and
 * evals (a publisher's own scenarios, `evals/<slug>`) at `/evals`. The server writes each one's
 * head and text, and the site its tabs, title, heading, and search, from these.
 */
export const DIRECTORY_VIEWS = {
  repositories: {
    path: "/",
    tab: "Repositories",
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    heading: HOME_HEADING,
    search: "Search Repositories",
  },
  evals: {
    path: "/evals",
    // Custom, as against a repository's: built from a publisher's own scenarios, not mined from a
    // repository's pull requests. Everything on the site is public, so "public" would say nothing.
    tab: "Custom Evals",
    title: `Custom Evals: Benchmark Coding Agents on Your Own Scenarios · ${SITE_NAME}`,
    description:
      "Coding agent and model results on evals publishers build from their own scenarios: accuracy and cost per task, side by side. By dari.dev.",
    heading: "Find the best models for evals",
    search: "Search Custom Evals",
  },
} as const;

export type DirectoryView = keyof typeof DIRECTORY_VIEWS;

/** The directory view a path shows, if it is one. */
export function directoryViewAt(path: string): DirectoryView | undefined {
  return (Object.keys(DIRECTORY_VIEWS) as DirectoryView[]).find(
    (view) => DIRECTORY_VIEWS[view].path === path,
  );
}

/** Whether a repository or eval, by its `owner/name`, is listed in `view`. */
export const listedIn = (view: DirectoryView, fullName: string) =>
  isEvalName(fullName) === (view === "evals");

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
 * The longest description search engines show whole: Bing flags longer ones, and Google cuts
 * them off around here.
 */
const DESCRIPTION_LIMIT = 160;

/**
 * A results page's description: its most accurate setting and the best one for less (the next
 * on the frontier: the most accurate of the settings that cost less), then what was measured.
 * Search results show only the first 150 or so characters, so the picks come first, and whole
 * sentences are left off the end rather than cut.
 */
function resultsDescription(
  subject: string,
  settings: readonly ReleaseSetting[],
  tasks: number,
  /** Where the tasks came from, ending the last sentence. */
  from: string,
  limit: number,
): string {
  const [best, next] = frontierSettings(settings).sort(
    (left, right) =>
      right.accuracy - left.accuracy ||
      left.costPerTaskUsd - right.costPerTaskUsd ||
      left.id.localeCompare(right.id),
  );
  const [question, ...rest] = [
    `Which coding agent works best on ${subject}?`,
    best ? `Most accurate: ${nameBeside(best, next)}, ${scored(best)} per task.` : "",
    next ? `Best for less: ${nameBeside(next, best)}, ${scored(next)}.` : "",
    `${settings.length} model ${settings.length === 1 ? "setting" : "settings"} scored on ${tasks} ${tasks === 1 ? "task" : "tasks"} ${from}.`,
  ].filter(Boolean);
  // Whole sentences, in order, while they fit; the question always leads.
  let text = question ?? "";
  for (const part of rest) {
    if (text.length + 1 + part.length > limit) break;
    text = `${text} ${part}`;
  }
  return text;
}

/** A repository page's description (`resultsDescription`). */
export function repositoryDescription(line: PublishedLine, limit = DESCRIPTION_LIMIT): string {
  const { release } = line;
  return resultsDescription(
    release.repository.fullName,
    release.settings,
    release.tasks,
    isEvalName(release.repository.fullName)
      ? "from its own scenarios"
      : "from its merged pull requests",
    limit,
  );
}

export function groupTitle(name: string): string {
  return `${name}: Coding Agent Benchmark · ${SITE_NAME}`;
}

/** A repository group's description, as a repository's, over every member's tasks. */
export function groupDescription(group: PublishedGroup, limit = DESCRIPTION_LIMIT): string {
  const count = group.members.length;
  return resultsDescription(
    group.name,
    group.settings,
    group.tasks,
    `from the merged pull requests of ${count} ${count === 1 ? "repository" : "repositories"}`,
    limit,
  );
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
