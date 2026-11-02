import { groupHref, mostAccurate, type PublishedGroup } from "../public/release-groups.js";
import { groupDescription, groupTitle, SITE_NAME } from "../public/seo.js";
import { escapeText } from "./http.js";
import { HOME_LINK, link, main, settingsTable } from "./site-body.js";
import { MEASUREMENT_TECHNIQUE, type PageHead } from "./site-head.js";

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

/** Each member's page: its line by the group's publisher. */
const memberHref = (group: PublishedGroup, fullName: string) =>
  `/${fullName}/${group.publisher.login}`;

export function groupHead(origin: string, group: PublishedGroup): PageHead {
  const canonical = groupCanonical(origin, group);
  const { login, kind } = group.publisher;
  const repositories = group.members.map((member) => member.repository.fullName);
  return {
    title: groupTitle(group.name),
    description: groupDescription(group),
    canonical,
    structuredData: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "BreadcrumbList",
          itemListElement: [
            { name: SITE_NAME, item: `${origin}/` },
            { name: group.name, item: canonical },
          ].map((crumb, index) => ({ "@type": "ListItem", position: index + 1, ...crumb })),
        },
        {
          "@type": "Dataset",
          "@id": `${canonical}#results`,
          name: `${group.name} coding agent benchmark results run by ${login}`,
          description: groupDescription(group, Number.POSITIVE_INFINITY),
          url: canonical,
          creator: {
            "@type": kind === "user" ? "Person" : "Organization",
            name: login,
            url: `https://github.com/${login}`,
          },
          includedInDataCatalog: { "@type": "DataCatalog", name: SITE_NAME, url: `${origin}/` },
          dateModified: group.updatedAt,
          isAccessibleForFree: true,
          keywords: ["coding agents", "AI models", "benchmark", "evals", ...repositories],
          about: repositories.map((fullName) => ({
            "@type": "SoftwareSourceCode",
            name: fullName,
            codeRepository: `https://github.com/${fullName}`,
          })),
          measurementTechnique: MEASUREMENT_TECHNIQUE,
          variableMeasured: [
            { "@type": "PropertyValue", name: "Accuracy", unitText: "percent" },
            { "@type": "PropertyValue", name: "Cost per task", unitText: "USD" },
          ],
          distribution: {
            "@type": "DataDownload",
            encodingFormat: "application/json",
            contentUrl: `${origin}/api/public${groupHref(login, group.slug)}`,
          },
        },
      ],
    },
  };
}

/** The group's name, what was measured and by whom, every pooled setting, and its members. */
export function groupBody(group: PublishedGroup): string {
  const facts = [
    `Run by ${group.publisher.login}`,
    `Updated ${day(group.updatedAt)}`,
    plural(group.members.length, "repository", "repositories"),
    plural(group.tasks, "task"),
    plural(group.settings.length, "setting"),
  ];
  const members = group.members.map((member) => {
    const best = mostAccurate(group, member);
    const summary = [
      `${plural(member.tasks, "task")}, released ${day(member.releasedAt)}.`,
      best ? `Most accurate here: ${best.label}, ${percent(best.accuracy)}.` : "",
    ];
    const { fullName } = member.repository;
    return `<li>${link(memberHref(group, fullName), fullName)} <span>${escapeText(summary.filter(Boolean).join(" "))}</span></li>`;
  });
  return main("group", [
    `<h1>${escapeText(group.name)}</h1>`,
    group.description ? `<p>${escapeText(group.description)}</p>` : "",
    `<p>${escapeText(facts.join(" · "))}</p>`,
    "<h2>Model Tradeoffs</h2>",
    `<p>${escapeText(groupDescription(group, Number.POSITIVE_INFINITY))}</p>`,
    "<h2>All Settings</h2>",
    group.settings.length > 0
      ? settingsTable(group.settings)
      : "<p>No setting was released on every repository in this group.</p>",
    "<h2>Repositories</h2>",
    `<ul>${members.join("")}</ul>`,
    HOME_LINK,
  ]);
}
