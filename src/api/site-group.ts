import { groupHref, mostAccurate, type PublishedGroup } from "../public/release-groups.js";
import { groupDescription, groupTitle } from "../public/seo.js";
import { escapeText } from "./http.js";
import { HOME_LINK, link, main, settingsTable } from "./site-body.js";
import { type PageHead, resultsStructuredData } from "./site-head.js";

/**
 * A repository group's page, as the server writes it before any script runs: its head for
 * search engines and link previews, and its text, in step with GroupPage.tsx.
 */

const percent = (value: number) => `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
const plural = (count: number, word: string, many = `${word}s`) =>
  `${count} ${count === 1 ? word : many}`;
const day = (iso: string) => iso.slice(0, 10);

/** The group's one address, in its publisher's own spelling. */
const groupCanonical = (origin: string, group: PublishedGroup) =>
  `${origin}${groupHref(group.publisher.login, group.slug)}`;

/** Each member on GitHub: a group's member need not be released on its own. */
const memberHref = (fullName: string) => `https://github.com/${fullName}`;

export function groupHead(origin: string, group: PublishedGroup): PageHead {
  const canonical = groupCanonical(origin, group);
  const { login } = group.publisher;
  return {
    title: groupTitle(group.name),
    description: groupDescription(group),
    canonical,
    structuredData: resultsStructuredData({
      origin,
      canonical,
      crumbs: [{ name: group.name, item: canonical }],
      name: `${group.name} coding agent benchmark results run by ${login}`,
      description: groupDescription(group, Number.POSITIVE_INFINITY),
      publisher: group.publisher,
      date: { dateModified: group.updatedAt },
      repositories: group.members.map((member) => member.repository.fullName),
      contentUrl: `${origin}/api/public${groupHref(login, group.slug)}`,
    }),
  };
}

/** The group's name, what was measured and by whom, every pooled setting, and its members. */
export function groupBody(group: PublishedGroup): string {
  const facts = [
    `Run by ${group.publisher.login}`,
    `Released ${day(group.updatedAt)}`,
    plural(group.members.length, "repository", "repositories"),
    plural(group.tasks, "task"),
    plural(group.settings.length, "setting"),
  ];
  const members = group.members.map((member) => {
    const best = mostAccurate(group, member);
    const summary = [
      `${plural(member.tasks, "task")}.`,
      best ? `Most accurate here: ${best.label}, ${percent(best.accuracy)}.` : "",
    ];
    const { fullName } = member.repository;
    return `<li>${link(memberHref(fullName), fullName)} <span>${escapeText(summary.filter(Boolean).join(" "))}</span></li>`;
  });
  return main("group", [
    `<h1>${escapeText(group.name)}</h1>`,
    group.description ? `<p>${escapeText(group.description)}</p>` : "",
    `<p>${escapeText(facts.join(" · "))}</p>`,
    // As on the page, the leaderboard's sections only when the members share a setting.
    ...(group.settings.length > 0
      ? [
          "<h2>Model Tradeoffs</h2>",
          `<p>${escapeText(groupDescription(group, Number.POSITIVE_INFINITY))}</p>`,
          "<h2>All Settings</h2>",
          settingsTable(group.settings),
        ]
      : ["<p>This release has no settings.</p>"]),
    "<h2>Repositories</h2>",
    `<ul>${members.join("")}</ul>`,
    HOME_LINK,
  ]);
}
