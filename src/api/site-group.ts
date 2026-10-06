import { harnessLabels } from "../evaluation/models.js";
import { frontierSettings } from "../public/directory.js";
import type { PublishedGroupRelease, ReleaseSetting } from "../public/release-types.js";
import { groupDescription, groupTitle, SITE_NAME } from "../public/seo.js";
import { escapeText } from "./http.js";
import { groupCardPath } from "./link-card.js";
import {
  day,
  dollars,
  HOME_LINK,
  link,
  main,
  percent,
  plural,
  settingsTable,
} from "./site-body.js";
import type { PageHead } from "./site-head.js";

/**
 * A group's page, `/groups/<slug>`, as the server writes it: its head and its text, as a
 * repository page's (site-head.ts, site-body.ts) but naming every repository it pools.
 */

/** The setting a group page's breakdown starts on: its most accurate, as the description names. */
export function leadingSetting(settings: readonly ReleaseSetting[]): ReleaseSetting | undefined {
  return [...frontierSettings(settings)].sort(
    (left, right) =>
      right.accuracy - left.accuracy ||
      left.costPerTaskUsd - right.costPerTaskUsd ||
      left.id.localeCompare(right.id),
  )[0];
}

export function groupHead(origin: string, release: PublishedGroupRelease): PageHead {
  const { slug, name, members } = release.group;
  const canonical = `${origin}/groups/${slug}`;
  const { login, kind } = release.publisher;
  return {
    title: groupTitle(name),
    description: groupDescription(release),
    canonical,
    structuredData: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${origin}/` },
            { "@type": "ListItem", position: 2, name, item: canonical },
          ],
        },
        {
          "@type": "Dataset",
          "@id": `${canonical}#results`,
          name: `${name} coding agent benchmark results`,
          // The whole summary: a dataset's description is read in full, not cut to a snippet.
          description: groupDescription(release, Number.POSITIVE_INFINITY),
          url: canonical,
          creator: {
            "@type": kind === "user" ? "Person" : "Organization",
            name: login,
            url: `https://github.com/${login}`,
          },
          includedInDataCatalog: { "@type": "DataCatalog", name: SITE_NAME, url: `${origin}/` },
          datePublished: release.releasedAt,
          isAccessibleForFree: true,
          keywords: [
            "coding agents",
            "AI models",
            "benchmark",
            "evals",
            name,
            ...members.map((member) => member.fullName),
          ],
          about: members.map((member) => ({
            "@type": "SoftwareSourceCode",
            name: member.fullName,
            codeRepository: `https://github.com/${member.fullName}`,
          })),
          measurementTechnique:
            "Tasks built from each repository's merged pull requests, each scored by hidden tests",
          variableMeasured: [
            { "@type": "PropertyValue", name: "Accuracy", unitText: "percent" },
            { "@type": "PropertyValue", name: "Cost per task", unitText: "USD" },
          ],
          distribution: {
            "@type": "DataDownload",
            encodingFormat: "application/json",
            contentUrl: `${origin}/api/public/groups/${slug}`,
          },
        },
      ],
    },
    // The release in the address, so a new release's card is fetched afresh, not an old copy.
    image: {
      url: `${origin}${groupCardPath(slug)}?v=${encodeURIComponent(release.releaseId)}`,
      alt: `Accuracy against cost per task for each model setting on ${name}`,
    },
  };
}

/** The breakdown's columns, as the page's own table names them. */
const BREAKDOWN = ["Repository", "Tasks", "Accuracy", "Cost / Task"] as const;

/**
 * A group page's text: its name and repositories, what was measured and by whom, every setting's
 * scores over all their tasks, and each repository's share for the most accurate setting.
 */
export function groupBody(release: PublishedGroupRelease): string {
  const { name, members } = release.group;
  const facts = [
    `Run by ${release.publisher.login}`,
    `Released ${day(release.releasedAt)}`,
    `${members.length} ${members.length === 1 ? "repository" : "repositories"}`,
    plural(release.tasks, "task"),
    plural(release.settings.length, "setting"),
  ];
  const lead = leadingSetting(release.settings);
  const byId = new Map(members.map((member) => [member.id, member.fullName]));
  const rows = release.breakdown.flatMap((share) => {
    const scored = share.settings.find((setting) => setting.id === lead?.id);
    const fullName = byId.get(share.repositoryId);
    if (!scored || !fullName) return [];
    const cells = [
      String(share.tasks),
      percent(scored.accuracy),
      dollars(scored.costPerTaskUsd),
    ].map((cell) => `<td>${escapeText(cell)}</td>`);
    return [`<tr><th scope="row">${escapeText(fullName)}</th>${cells.join("")}</tr>`];
  });
  const headings = BREAKDOWN.map((heading) => `<th scope="col">${escapeText(heading)}</th>`);
  return main("repository", [
    `<h1 class="name">${escapeText(name)}</h1>`,
    `<p>${members.map((member) => link(`https://github.com/${member.fullName}`, member.fullName)).join(", ")}</p>`,
    `<p>${escapeText(facts.join(" · "))}</p>`,
    `<p>${escapeText(groupDescription(release, Number.POSITIVE_INFINITY))}</p>`,
    "<h2>All Settings</h2>",
    settingsTable(release.settings),
    ...(lead && rows.length > 0
      ? [
          "<h2>By Repository</h2>",
          `<p>${escapeText(`${lead.model.label} on ${harnessLabels[lead.harness] ?? lead.harness}, the most accurate setting, in each repository.`)}</p>`,
          `<div class="page-text-table"><table><thead><tr>${headings.join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`,
        ]
      : []),
    // The tasks themselves are kept out of crawls (robots.txt); the page only says they are there.
    ...(release.tasksPublished
      ? [
          "<h2>Tasks</h2>",
          `<p>${escapeText(`All ${plural(release.tasks, "task")}, each with its instruction, tests, and solution to browse and download.`)}</p>`,
        ]
      : []),
    HOME_LINK,
  ]);
}
