import { resultsName } from "../public/paths.js";
import type { PublishedLine } from "../public/release-types.js";
import {
  DIRECTORY_VIEWS,
  type DirectoryView,
  defaultLineOf,
  HOME_DESCRIPTION,
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

/** A directory view's head: the home page's, with the site's own data, or the evals page's. */
export function homeHead(origin: string, view: DirectoryView = "repositories"): PageHead {
  const { title, description, path } = DIRECTORY_VIEWS[view];
  return {
    title,
    description,
    canonical: `${origin}${path}`,
    ...(view === "repositories" ? { structuredData: siteStructuredData(origin) } : {}),
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
  const address = resultsName(line.release);
  const own = line === defaultLineOf(lines) ? undefined : line.release.publisher.login;
  const canonical = own ? `${origin}/${address}/${own}` : `${origin}/${address}`;
  return {
    title: repositoryTitle(fullName),
    description: repositoryDescription(line),
    canonical,
    structuredData: repositoryStructuredData(origin, line, canonical, own),
    // The release in the address, so a new release's card is fetched afresh, not an old copy.
    image: {
      url: `${origin}${cardPath(address, own)}?v=${encodeURIComponent(line.release.releaseId)}`,
      alt: `Accuracy against cost per task for each model setting on ${fullName}`,
    },
  };
}

/** How SelfBench measures, for the Dataset of a repository or a group, or a public benchmark. */
const MEASUREMENT_TECHNIQUE =
  "Tasks built from the repository's merged pull requests, each scored by hidden tests";
const BENCHMARK_TECHNIQUE =
  "The public benchmark's own tasks, as published in its registry, each scored by its own tests";

/** What a page's results are, as schema.org data: a repository's, or a group's. */
export interface ResultsData {
  origin: string;
  canonical: string;
  /** Its place in the site after the home page, each with its address. */
  crumbs: { name: string; item: string }[];
  name: string;
  description: string;
  publisher: { login: string; kind: "org" | "user" };
  date: { datePublished: string } | { dateModified: string };
  /** The repositories it measures. */
  repositories: string[];
  /** The public API address its numbers download from. */
  contentUrl: string;
  /** A public benchmark's results, measured on its own tasks rather than built ones. */
  benchmark?: true;
}

/**
 * A page's results as schema.org data. Its breadcrumbs name its place in the site, so results
 * can show "SelfBench › owner/name" rather than guess from the address. Its results are a
 * Dataset: what was measured, by whom, when, and where the numbers can be downloaded, which is
 * what Google Dataset Search lists.
 */
export function resultsStructuredData(data: ResultsData): Record<string, unknown> {
  const { origin, canonical, publisher } = data;
  const crumbs = [{ name: SITE_NAME, item: `${origin}/` }, ...data.crumbs];
  const about = data.repositories.map((fullName) => ({
    "@type": "SoftwareSourceCode",
    name: fullName,
    codeRepository: `https://github.com/${fullName}`,
  }));
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
        name: data.name,
        // The whole summary: a dataset's description is read in full, not cut to a snippet.
        description: data.description,
        url: canonical,
        creator: {
          "@type": publisher.kind === "user" ? "Person" : "Organization",
          name: publisher.login,
          url: `https://github.com/${publisher.login}`,
        },
        includedInDataCatalog: { "@type": "DataCatalog", name: SITE_NAME, url: `${origin}/` },
        ...data.date,
        isAccessibleForFree: true,
        keywords: ["coding agents", "AI models", "benchmark", "evals", ...data.repositories],
        ...(about.length > 0 ? { about: about.length === 1 ? about[0] : about } : {}),
        measurementTechnique: data.benchmark ? BENCHMARK_TECHNIQUE : MEASUREMENT_TECHNIQUE,
        variableMeasured: [
          { "@type": "PropertyValue", name: "Accuracy", unitText: "percent" },
          { "@type": "PropertyValue", name: "Cost per task", unitText: "USD" },
        ],
        distribution: {
          "@type": "DataDownload",
          encodingFormat: "application/json",
          contentUrl: data.contentUrl,
        },
      },
    ],
  };
}

/** A repository page as schema.org data (`resultsStructuredData`). */
function repositoryStructuredData(
  origin: string,
  line: PublishedLine,
  canonical: string,
  own: string | undefined,
): Record<string, unknown> {
  const { release } = line;
  const { fullName } = release.repository;
  const address = resultsName(release);
  return resultsStructuredData({
    origin,
    canonical,
    crumbs: [
      ...(release.benchmark
        ? [
            {
              name: DIRECTORY_VIEWS.benchmarks.tab,
              item: `${origin}${DIRECTORY_VIEWS.benchmarks.path}`,
            },
          ]
        : []),
      { name: fullName, item: `${origin}/${address}` },
      ...(own ? [{ name: `Run by ${own}`, item: canonical }] : []),
    ],
    name: `${fullName} coding agent benchmark results${own ? ` run by ${own}` : ""}`,
    description: repositoryDescription(line, Number.POSITIVE_INFINITY),
    publisher: release.publisher,
    date: { datePublished: release.releasedAt },
    // A public benchmark has no repository behind it to name.
    repositories: release.benchmark ? [] : [fullName],
    contentUrl: `${origin}/api/public/results/${address}`,
    ...(release.benchmark ? { benchmark: true as const } : {}),
  });
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
