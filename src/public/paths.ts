/**
 * The one definition of which selfbench.dev paths name a repository or a group. Page status and the
 * public API both read it, so anything else is refused before any lookup. Names follow
 * GitHub's character set and lengths: owners and publishers up to 39 characters, repositories
 * up to 100, of letters, digits, `.`, `_` and `-` (never `.` or `..` alone).
 */

const NAME = /^[A-Za-z0-9._-]+$/;

const valid = (name: string, longest: number) =>
  name.length <= longest && NAME.test(name) && name !== "." && name !== "..";

/** A repository page, `/owner/name`, or one publisher's line of it, `/owner/name/publisher`. */
export interface RepositoryPath {
  owner: string;
  name: string;
  publisher?: string;
}

/**
 * The repository named by path segments `[owner, name]` or `[owner, name, publisher]`, or
 * undefined when they are not a repository at all. Segments are percent-decoded first.
 */
export function repositoryPath(segments: readonly string[]): RepositoryPath | undefined {
  if (segments.length < 2 || segments.length > 3) return undefined;
  let decoded: string[];
  try {
    decoded = segments.map(decodeURIComponent);
  } catch {
    return undefined;
  }
  const [owner = "", name = "", publisher] = decoded;
  if (!valid(owner, 39) || !valid(name, 100)) return undefined;
  if (publisher !== undefined && !valid(publisher, 39)) return undefined;
  return publisher === undefined ? { owner, name } : { owner, name, publisher };
}

/** A group's address on selfbench.dev, `/groups/<slug>`: lowercase words joined by hyphens. */
export const GROUP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** The slug a path segment names, or undefined when it is not one. */
export function groupSlug(segment: string | undefined): string | undefined {
  return segment !== undefined && GROUP_SLUG.test(segment) ? segment : undefined;
}

/** The group named by path segments `["groups", slug]`, or undefined when they name none. */
export function groupPath(segments: readonly string[]): string | undefined {
  return segments.length === 2 && segments[0] === "groups" ? groupSlug(segments[1]) : undefined;
}

/** A slug from the group's name, offered for its first release. */
export function suggestedSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug || "group";
}

/** The non-empty segments of a URL path. */
export const segmentsOf = (pathname: string) => pathname.split("/").filter(Boolean);
