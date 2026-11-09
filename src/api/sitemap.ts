import { resultsName } from "../public/paths.js";
import { groupHref, type PublishedGroup } from "../public/release-groups.js";
import type { PublishedLine } from "../public/release-types.js";
import { DIRECTORY_VIEWS, defaultLineOf } from "../public/seo.js";

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
 * Every page the site can show, for search engines: the home page, the evals page once there is
 * an eval, each repository's and eval's page, each other publisher's line, and each repository
 * group, at their canonical addresses, each dated by its newest release.
 * Built from the released lines, so a new release is listed without any step of its own.
 */
export function sitemapOf(
  origin: string,
  repositories: readonly (readonly PublishedLine[])[],
  groups: readonly PublishedGroup[] = [],
): string {
  const pages: { loc: string; lastmod: string | undefined }[] = groups.map((group) => ({
    loc: `${origin}${groupHref(group.publisher.login, group.slug)}`,
    lastmod: group.updatedAt,
  }));
  for (const lines of repositories) {
    const fallback = defaultLineOf(lines);
    if (!fallback) continue;
    const address = resultsName(fallback.release);
    pages.push({
      loc: `${origin}/${address}`,
      lastmod: newest(lines.map((line) => line.release.releasedAt)),
    });
    for (const line of lines) {
      if (line === fallback) continue;
      pages.push({
        loc: `${origin}/${address}/${line.release.publisher.login}`,
        lastmod: line.release.releasedAt,
      });
    }
  }
  pages.sort((left, right) => left.loc.localeCompare(right.loc));
  const home = {
    loc: `${origin}/`,
    lastmod: newest([
      ...repositories.flat().map((line) => line.release.releasedAt),
      ...groups.map((group) => group.updatedAt),
    ]),
  };
  const evals = repositories
    .flat()
    .filter((line) => line.release.benchmark)
    .map((line) => line.release.releasedAt);
  const evalsPage = { loc: `${origin}${DIRECTORY_VIEWS.benchmarks.path}`, lastmod: newest(evals) };
  const urls = [home, ...(evals.length > 0 ? [evalsPage] : []), ...pages].map(
    ({ loc, lastmod }) =>
      `  <url><loc>${escapeXml(loc)}</loc>${lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : ""}</url>\n`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("")}</urlset>\n`;
}
