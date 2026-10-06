import { groupPath, repositoryPath, segmentsOf } from "../public/paths.js";
import type { PublicReleaseRoutes } from "./routes/public-releases.js";
import { homeBody, notFoundBody, pageData, repositoryBody } from "./site-body.js";
import { groupBody, groupHead, groupNotFound } from "./site-group.js";
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
   * The page's head and text, with 200 for the directory and released repositories and 404 for
   * anything the site cannot show. A path that cannot name a repository is refused without a
   * lookup. Both read the snapshot of released lines, never the database. `partial` marks a home
   * page written without its directory, because the snapshot could not be read: it is still
   * served, but never cached, so the CDN never keeps a directory with nothing in it.
   */
  return async (pathname: string): Promise<SitePage> => {
    if (pathname === "/") {
      const repositories = await publicRoutes.repositories().catch(() => undefined);
      const groups = repositories && (await publicRoutes.groups().catch(() => undefined));
      const directory = groups && (await publicRoutes.directoryBody().catch(() => undefined));
      return {
        status: 200,
        head: homeHead(origin),
        body: homeBody(repositories ?? [], groups ?? []),
        data: pageData("/api/public/results", directory),
        partial: !groups,
      };
    }
    const slug = groupPath(segmentsOf(pathname));
    if (slug) {
      const release = await publicRoutes.groupFor(slug).catch(() => undefined);
      if (!release) return { status: 404, ...groupNotFound(slug) };
      // Addressed as the site asks for it (api-source.ts).
      const api = `/api/public/groups/${encodeURIComponent(slug)}`;
      return {
        status: 200,
        head: groupHead(origin, release),
        body: groupBody(release),
        data: pageData(api, await publicRoutes.groupBody(slug).catch(() => undefined)),
      };
    }
    const path = repositoryPath(segmentsOf(pathname));
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
