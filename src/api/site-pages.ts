import { groupPath, repositoryPath, segmentsOf } from "../public/paths.js";
import { groupHref } from "../public/release-groups.js";
import { directoryViewAt } from "../public/seo.js";
import type { PublicReleaseRoutes } from "./routes/public-releases.js";
import { homeBody, notFoundBody, pageData, repositoryBody } from "./site-body.js";
import { groupBody, groupHead } from "./site-group.js";
import { homeHead, notFoundHead, type PageHead, repositoryHead } from "./site-head.js";

/** A selfbench.dev page as the server writes it, before the shell is filled in. */
export interface SitePage {
  status: 200 | 404;
  head: PageHead;
  /** The page's text, written into its root. */
  body: string;
  /** The API response its first render reads, carried in the page (site-body.ts). */
  data?: string;
  /** A home page written without its directory: served, never cached. */
  partial?: boolean;
}

export function sitePages(origin: string, publicRoutes: PublicReleaseRoutes) {
  /**
   * The page's head and text, with 200 for the directory's views and released repositories and 404 for
   * anything the site cannot show. A path that cannot name a repository is refused without a
   * lookup. Both read the snapshot of released lines, never the database. `partial` marks a home
   * page written without its directory, because the snapshot could not be read: it is still
   * served, but never cached, so the CDN never keeps a directory with nothing in it.
   */
  return async (pathname: string): Promise<SitePage> => {
    const view = directoryViewAt(pathname);
    if (view) {
      const repositories = await publicRoutes.repositories().catch(() => undefined);
      const groups = repositories && (await publicRoutes.groups().catch(() => undefined));
      const directory = repositories && (await publicRoutes.directoryBody().catch(() => undefined));
      return {
        status: 200,
        head: homeHead(origin, view),
        body: homeBody(repositories ?? [], groups ?? [], view),
        data: pageData("/api/public/results", directory),
        partial: !repositories,
      };
    }
    const segments = segmentsOf(pathname);
    const named = groupPath(segments);
    if (named) {
      const group = await publicRoutes.groupFor(named.publisher, named.slug).catch(() => undefined);
      if (!group) return { status: 404, head: notFoundHead(), body: notFoundBody() };
      const api = `/api/public${groupHref(named.publisher, named.slug)}`;
      const data = await publicRoutes.groupBody(named.publisher, named.slug).catch(() => undefined);
      return {
        status: 200,
        head: groupHead(origin, group),
        body: groupBody(group),
        data: pageData(api, data),
      };
    }
    const path = repositoryPath(segments);
    if (!path) return { status: 404, head: notFoundHead(), body: notFoundBody() };
    const fullName = `${path.owner}/${path.name}`;
    const lines = await publicRoutes.linesFor(fullName).catch(() => []);
    const head = repositoryHead(origin, lines, path.publisher);
    const body = repositoryBody(lines, path.publisher);
    // Addressed as the site asks for it: the path's own spelling, each part encoded.
    const api = `/api/public/results/${encodeURIComponent(path.owner)}/${encodeURIComponent(path.name)}`;
    const data = pageData(api, await publicRoutes.repositoryBody(fullName).catch(() => undefined));
    return head && body
      ? { status: 200, head, body, data }
      : { status: 404, head: notFoundHead(fullName), body: notFoundBody(fullName) };
  };
}
