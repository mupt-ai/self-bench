import { harnessLabels } from "../evaluation/models.js";
import { gateways, isGateway } from "../gateways/index.js";
import { directoryOf } from "../public/directory.js";
import type { PublishedLine, ReleaseSetting } from "../public/release-types.js";
import {
  defaultLineOf,
  HOME_DESCRIPTION,
  HOME_HEADING,
  repositoryDescription,
} from "../public/seo.js";
import { escapeAttribute, escapeText } from "./http.js";
import { lineAt } from "./site-head.js";

/**
 * What a selfbench.dev page says before any script runs: its heading and content as plain HTML,
 * written by the server into the page's root. The site renders in the browser, so without it a
 * crawler that runs no scripts finds an empty page. The site's script replaces it with the page
 * itself, and until then everyone sees it, so it is never hidden: it is the same page, plainer,
 * set in the page's own column by page-text.css.
 */

/** The home page lists as many repositories as its directory shows (HomePage.tsx). */
const HOME_LIMIT = 100;

const percent = (value: number) => `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
const dollars = (value: number) => (value === 0 ? "$0" : `$${value.toFixed(value < 0.1 ? 3 : 2)}`);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const day = (iso: string) => iso.slice(0, 10);

const link = (href: string, text: string) =>
  `<a href="${escapeAttribute(href)}">${escapeText(text)}</a>`;
const HOME_LINK = `<p>${link("/", "All Repositories on SelfBench")}</p>`;

/** The page's main content, as the root's only child; `kind` sets its layout in page-text.css. */
const main = (kind: "home" | "repository" | "missing", parts: readonly string[]) =>
  `<main class="page-text" data-page="${kind}">${parts.join("")}</main>`;

/** The directory's heading and every repository's default line, newest first, as the page lists them. */
export function homeBody(repositories: readonly (readonly PublishedLine[])[]): string {
  const cards = directoryOf(repositories.flat())
    .filter((card) => card.defaultLine)
    .slice(0, HOME_LIMIT);
  const items = cards.map((card) => {
    // The repository's two picks, as its description names them: the most accurate setting and
    // the next on the frontier, the most accurate of those that cost less.
    const [best, next] = [...card.frontier].sort(
      (left, right) =>
        right.accuracy - left.accuracy ||
        left.costPerTaskUsd - right.costPerTaskUsd ||
        left.id.localeCompare(right.id),
    );
    const scored = (setting: { accuracy: number; costPerTaskUsd: number }) =>
      `${percent(setting.accuracy)} at ${dollars(setting.costPerTaskUsd)}`;
    const facts = [
      `${plural(card.tasks, "task")}, ${plural(card.settings, "setting")}, run by ${card.publisher.login}.`,
      best ? `Most accurate: ${best.model.label}, ${scored(best)} per task.` : "",
      next ? `Best for less: ${next.model.label}, ${scored(next)}.` : "",
    ];
    return `<li>${link(`/${card.repository.fullName}`, card.repository.fullName)} <span>${escapeText(facts.filter(Boolean).join(" "))}</span></li>`;
  });
  return main("home", [
    `<h1>${escapeText(HOME_HEADING)}</h1>`,
    `<p>${escapeText(HOME_DESCRIPTION)}</p>`,
    items.length > 0 ? `<ul>${items.join("")}</ul>` : "",
  ]);
}

const reasoning = ({ reasoningLevel: level }: ReleaseSetting) =>
  level === "xhigh" ? "X-High" : level.charAt(0).toUpperCase() + level.slice(1);
const access = (setting: ReleaseSetting) =>
  setting.custom
    ? "Custom Endpoint"
    : setting.signIn === "codex-login"
      ? "ChatGPT Sign-In"
      : setting.signIn === "claude-login"
        ? "Claude Sign-In"
      : isGateway(setting.provider)
        ? gateways[setting.provider].label
        : "API Key";

/** The settings table's columns, as the page's own table names them, plus the frontier it marks. */
const COLUMNS: readonly [string, (setting: ReleaseSetting) => string][] = [
  ["Model", (setting) => setting.model.label],
  ["Harness", (setting) => harnessLabels[setting.harness] ?? setting.harness],
  ["Reasoning", reasoning],
  ["Access", access],
  ["Accuracy", (setting) => percent(setting.accuracy)],
  ["Cost / Task", (setting) => dollars(setting.costPerTaskUsd)],
  ["Frontier", (setting) => (setting.onFrontier ? "Yes" : "No")],
];

/** Every setting, most accurate first, then cheapest, as the page's table starts. */
function settingsTable(settings: readonly ReleaseSetting[]): string {
  const rows = [...settings]
    .sort(
      (left, right) =>
        right.accuracy - left.accuracy ||
        left.costPerTaskUsd - right.costPerTaskUsd ||
        left.id.localeCompare(right.id),
    )
    .map((setting) => {
      const [model, ...rest] = COLUMNS.map(([, cell]) => escapeText(cell(setting)));
      return `<tr><th scope="row">${model}</th>${rest.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
    });
  const headings = COLUMNS.map(([heading]) => `<th scope="col">${escapeText(heading)}</th>`);
  return `<div class="page-text-table"><table><thead><tr>${headings.join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

/**
 * A repository page, or one publisher's line of it: the repository's name, what was measured and
 * by whom, every setting's scores, and the repository's other lines. Undefined when there is
 * nothing to show, as for its head (site-head.ts).
 */
export function repositoryBody(
  lines: readonly PublishedLine[],
  publisher?: string,
): string | undefined {
  const line = lineAt(lines, publisher);
  if (!line) return undefined;
  const { release } = line;
  const { fullName } = release.repository;
  const [owner, name] = fullName.split("/");
  // GitHub's description, without the emoji shortcodes the page drops too (cleanDescription).
  const about = release.repository.description?.replace(/:[a-z0-9_+-]+:\s*/g, "").trim();
  const fallback = defaultLineOf(lines);
  const facts = [
    `Run by ${release.publisher.login}`,
    `Released ${day(release.releasedAt)}`,
    plural(release.tasks, "task"),
    plural(release.settings.length, "setting"),
    ...(line.endorsed ? ["Endorsed by Maintainers"] : []),
  ];
  const others = lines
    .filter((other) => other !== line)
    .sort(
      (left, right) =>
        right.release.releasedAt.localeCompare(left.release.releasedAt) ||
        left.release.releaseId.localeCompare(right.release.releaseId),
    )
    .map((other) => {
      // Each line at its canonical address: the default line's is the repository's.
      const { tasks, settings, publisher: by, releasedAt } = other.release;
      const href = other === fallback ? `/${fullName}` : `/${fullName}/${by.login}`;
      const summary = `${plural(tasks, "task")}, ${plural(settings.length, "setting")}, released ${day(releasedAt)}.`;
      return `<li>${link(href, by.login)} <span>${escapeText(summary)}</span></li>`;
    });
  return main("repository", [
    // A long name wraps after the owner, as on the page.
    `<h1 class="name">${escapeText(owner ?? "")}/<wbr />${escapeText(name ?? "")}</h1>`,
    // The page's own lines under its name, then the head's summary of the results.
    about ? `<p>${escapeText(about)}</p>` : "",
    `<p>${escapeText(facts.join(" · "))}</p>`,
    // The whole summary: only the head's copy is kept short for search results.
    `<p>${escapeText(repositoryDescription(line, Number.POSITIVE_INFINITY))}</p>`,
    "<h2>All Settings</h2>",
    settingsTable(release.settings),
    "<p>A setting is on the frontier when no other is both cheaper and more accurate.</p>",
    ...(others.length > 0
      ? ["<h2>Other Benchmarks of This Repo</h2>", `<ul>${others.join("")}</ul>`]
      : []),
    HOME_LINK,
  ]);
}

/** A page the site cannot show: a repository with nothing released, or no page at all. */
export function notFoundBody(fullName?: string): string {
  return main("missing", [
    fullName ? `<h1 class="name">${escapeText(fullName)}</h1>` : "<h1>Page Not Found</h1>",
    `<p>${fullName ? "No evals for this repo yet." : "Nothing is at this address."}</p>`,
    HOME_LINK,
  ]);
}

/**
 * Past this, a page carries no data and the site fetches it as it does between pages: the block
 * is read before the page can draw, so it must stay small next to the page itself.
 */
const DATA_LIMIT = 256 * 1024;

/**
 * The API response a page's first render reads, carried in the page itself: `body` is exactly
 * what `url` answers. The site takes it instead of asking (api-source.ts), which saves the round
 * trip between the script starting and the page appearing. `<` is escaped, so nothing in a
 * release can close the script.
 */
export function pageData(url: string, body: string | undefined): string {
  if (body === undefined || body.length > DATA_LIMIT) return "";
  return `<script type="application/json" id="page-data" data-url="${escapeAttribute(url)}">${body.replaceAll("<", "\\u003c")}</script>`;
}
