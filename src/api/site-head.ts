import type { PublishedLine } from "../public/release-types.js";
import {
  defaultLineOf,
  HOME_DESCRIPTION,
  HOME_TITLE,
  repositoryDescription,
  repositoryTitle,
  SITE_NAME,
  siteStructuredData,
} from "../public/seo.js";
import { escapeAttribute } from "./http.js";
import { CARD_HEIGHT, CARD_WIDTH, cardPath } from "./link-card.js";

/**
 * What a selfbench.dev page tells search engines and link previews before any script runs. The
 * site renders in the browser, so without this every page would read the same.
 */
export interface PageHead {
  title: string;
  description: string;
  /** The page's one address, in its repository's own casing; none on a page that is not found. */
  canonical?: string;
  /**
   * The page as schema.org data: who the site is on the home page, and on a repository page its
   * place in the site and its results as a dataset.
   */
  structuredData?: Record<string, unknown>;
  /**
   * The picture a shared link shows, 1200 × 630: a repository's card, drawn for its release
   * (link-card.ts). Pages without one show the site's icon in a small card instead.
   */
  image?: { url: string; alt: string };
}

export function homeHead(origin: string): PageHead {
  return {
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    canonical: `${origin}/`,
    structuredData: siteStructuredData(origin),
  };
}

/**
 * A repository page's head, or one publisher's line of it; undefined when there is nothing to
 * show. The default line is one page whichever address reaches it, so its canonical address is
 * the repository's; another publisher's line is a page of its own.
 */
export function repositoryHead(
  origin: string,
  lines: readonly PublishedLine[],
  publisher?: string,
): PageHead | undefined {
  const line = lineAt(lines, publisher);
  if (!line) return undefined;
  const { fullName } = line.release.repository;
  const own = line === defaultLineOf(lines) ? undefined : line.release.publisher.login;
  const canonical = own ? `${origin}/${fullName}/${own}` : `${origin}/${fullName}`;
  return {
    title: repositoryTitle(fullName),
    description: repositoryDescription(line),
    canonical,
    structuredData: repositoryStructuredData(origin, line, canonical, own),
    // The release in the address, so a new release's card is fetched afresh, not an old copy.
    image: {
      url: `${origin}${cardPath(fullName, own)}?v=${encodeURIComponent(line.release.releaseId)}`,
      alt: `Accuracy against cost per task for each model setting on ${fullName}`,
    },
  };
}

/**
 * A repository page as schema.org data. Its breadcrumbs name its place in the site, so results
 * can show "SelfBench › owner/name" rather than guess from the address. Its release is a
 * Dataset: what was measured, by whom, when, and where the numbers can be downloaded, which is
 * what Google Dataset Search lists.
 */
function repositoryStructuredData(
  origin: string,
  line: PublishedLine,
  canonical: string,
  own: string | undefined,
): Record<string, unknown> {
  const { release } = line;
  const { fullName } = release.repository;
  const { login, kind } = release.publisher;
  const crumbs = [
    { name: SITE_NAME, item: `${origin}/` },
    { name: fullName, item: `${origin}/${fullName}` },
    ...(own ? [{ name: `Run by ${own}`, item: canonical }] : []),
  ];
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: crumbs.map((crumb, index) => ({
          "@type": "ListItem",
          position: index + 1,
          ...crumb,
        })),
      },
      {
        "@type": "Dataset",
        "@id": `${canonical}#results`,
        name: `${fullName} coding agent benchmark results${own ? ` run by ${own}` : ""}`,
        // The whole summary: a dataset's description is read in full, not cut to a snippet.
        description: repositoryDescription(line, Number.POSITIVE_INFINITY),
        url: canonical,
        creator: {
          "@type": kind === "user" ? "Person" : "Organization",
          name: login,
          url: `https://github.com/${login}`,
        },
        includedInDataCatalog: { "@type": "DataCatalog", name: SITE_NAME, url: `${origin}/` },
        datePublished: release.releasedAt,
        isAccessibleForFree: true,
        keywords: ["coding agents", "AI models", "benchmark", "evals", fullName],
        about: {
          "@type": "SoftwareSourceCode",
          name: fullName,
          codeRepository: `https://github.com/${fullName}`,
        },
        measurementTechnique:
          "Tasks built from the repository's merged pull requests, each scored by hidden tests",
        variableMeasured: [
          { "@type": "PropertyValue", name: "Accuracy", unitText: "percent" },
          { "@type": "PropertyValue", name: "Cost per task", unitText: "USD" },
        ],
        distribution: {
          "@type": "DataDownload",
          encodingFormat: "application/json",
          contentUrl: `${origin}/api/public/repos/${fullName}`,
        },
      },
    ],
  };
}

/** The line a repository address shows: its publisher's, or the repository's default one. */
export function lineAt(
  lines: readonly PublishedLine[],
  publisher?: string,
): PublishedLine | undefined {
  if (!publisher) return defaultLineOf(lines);
  return lines.find(
    (each) => each.release.publisher.login.toLowerCase() === publisher.toLowerCase(),
  );
}

/** A page the site cannot show: named as the site will name it, with no address of its own. */
export function notFoundHead(fullName?: string): PageHead {
  return {
    title: fullName ? repositoryTitle(fullName) : SITE_NAME,
    description: HOME_DESCRIPTION,
  };
}

/** Escapes `</script>` and the like out of JSON written inside a script tag. */
const scriptJson = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");

/** The head's tags, one per line, indented to sit in the shell's head. */
export function headTags(head: PageHead, origin: string): string {
  const title = escapeAttribute(head.title);
  const description = escapeAttribute(head.description);
  return [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    ...(head.canonical
      ? [`<link rel="canonical" href="${escapeAttribute(head.canonical)}" />`]
      : []),
    '<meta property="og:type" content="website" />',
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    ...(head.canonical
      ? [`<meta property="og:url" content="${escapeAttribute(head.canonical)}" />`]
      : []),
    ...(head.image
      ? [
          `<meta property="og:image" content="${escapeAttribute(head.image.url)}" />`,
          `<meta property="og:image:width" content="${CARD_WIDTH}" />`,
          `<meta property="og:image:height" content="${CARD_HEIGHT}" />`,
          `<meta property="og:image:alt" content="${escapeAttribute(head.image.alt)}" />`,
          '<meta name="twitter:card" content="summary_large_image" />',
        ]
      : [
          `<meta property="og:image" content="${escapeAttribute(origin)}/icon-192.png" />`,
          '<meta name="twitter:card" content="summary" />',
        ]),
    ...(head.structuredData
      ? [`<script type="application/ld+json">${scriptJson(head.structuredData)}</script>`]
      : []),
  ]
    .map((tag) => `    ${tag}\n`)
    .join("");
}

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const newest = (dates: readonly string[]) =>
  dates.reduce<string | undefined>(
    (latest, date) => (!latest || date > latest ? date : latest),
    undefined,
  );

/**
 * Every page the site can show, for search engines: the home page, each repository's page, and
 * each other publisher's line, at their canonical addresses, each dated by its newest release.
 * Built from the released lines, so a new release is listed without any step of its own.
 */
export function sitemapOf(
  origin: string,
  repositories: readonly (readonly PublishedLine[])[],
): string {
  const pages: { loc: string; lastmod: string | undefined }[] = [];
  for (const lines of repositories) {
    const fallback = defaultLineOf(lines);
    if (!fallback) continue;
    const { fullName } = fallback.release.repository;
    pages.push({
      loc: `${origin}/${fullName}`,
      lastmod: newest(lines.map((line) => line.release.releasedAt)),
    });
    for (const line of lines) {
      if (line === fallback) continue;
      pages.push({
        loc: `${origin}/${fullName}/${line.release.publisher.login}`,
        lastmod: line.release.releasedAt,
      });
    }
  }
  pages.sort((left, right) => left.loc.localeCompare(right.loc));
  const home = {
    loc: `${origin}/`,
    lastmod: newest(repositories.flat().map((line) => line.release.releasedAt)),
  };
  const urls = [home, ...pages].map(
    ({ loc, lastmod }) =>
      `  <url><loc>${escapeXml(loc)}</loc>${lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : ""}</url>\n`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("")}</urlset>\n`;
}
