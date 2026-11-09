import { EVAL_OWNER } from "../contracts/evals.js";

/**
 * The one definition of which selfbench.dev paths name a repository. Page status and the
 * public API both read it, so anything else is refused before any lookup. Names follow
 * GitHub's character set and lengths: owners and publishers up to 39 characters, repositories
 * up to 100, of letters, digits, `.`, `_` and `-` (never `.` or `..` alone).
 */

const NAME = /^[A-Za-z0-9._-]+$/;

const valid = (name: string, longest: number) =>
  name.length <= longest && NAME.test(name) && name !== "." && name !== "..";

/**
 * Where public benchmarks' pages live: `/evals/org/name`, the benchmark's registry name after the
 * app's reserved `evals` owner. No connected repository can have that owner (EVAL_OWNER), so no
 * repository's page is ever at one of these addresses.
 */
export const BENCHMARKS = EVAL_OWNER;

/**
 * A results page, `/owner/name`, or one publisher's line of it, `/owner/name/publisher`: a
 * repository's, or with `benchmark` a public benchmark's, `/evals/org/name[/publisher]`.
 */
export interface RepositoryPath {
  owner: string;
  name: string;
  publisher?: string;
  benchmark?: true;
}

/**
 * A line's name in its page's address, which tells a repository from a public benchmark of the
 * same name: a repository's `owner/name`, or a benchmark's `evals/org/name`.
 */
export const resultsName = (line: { repository: { fullName: string }; benchmark?: unknown }) =>
  line.benchmark ? `${BENCHMARKS}/${line.repository.fullName}` : line.repository.fullName;

/** The name a path addresses, as `resultsName` gives it. */
export const pathName = (path: RepositoryPath) =>
  `${path.benchmark ? `${BENCHMARKS}/` : ""}${path.owner}/${path.name}`;

/**
 * The repository named by path segments `[owner, name]` or `[owner, name, publisher]`, or the
 * public benchmark by the same after `evals`, or undefined when they are neither. Segments are percent-decoded first.
 */
export function repositoryPath(segments: readonly string[]): RepositoryPath | undefined {
  const benchmark = segments[0]?.toLowerCase() === BENCHMARKS;
  const parts = benchmark ? segments.slice(1) : segments;
  if (parts.length < 2 || parts.length > 3) return undefined;
  let decoded: string[];
  try {
    decoded = parts.map(decodeURIComponent);
  } catch {
    return undefined;
  }
  const [owner = "", name = "", publisher] = decoded;
  // A registry org, unlike a GitHub account, may run to 100 characters.
  if (!valid(owner, benchmark ? 100 : 39) || !valid(name, 100)) return undefined;
  // The groups' own addresses; GitHub has no account by that name.
  if (owner.toLowerCase() === GROUPS && !benchmark) return undefined;
  if (publisher !== undefined && !valid(publisher, 39)) return undefined;
  return {
    owner,
    name,
    ...(publisher === undefined ? {} : { publisher }),
    ...(benchmark ? { benchmark: true as const } : {}),
  };
}

const GROUPS = "groups";

/** A group's slug: lower-case letters, digits and single hyphens, as `python-web-frameworks`. */
export const GROUP_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const GROUP_SLUG_MAX = 60;

/** A repository group's page, `/groups/publisher/slug`. */
export interface GroupPath {
  publisher: string;
  slug: string;
}

/** The group named by path segments `["groups", publisher, slug]`, or undefined. */
export function groupPath(segments: readonly string[]): GroupPath | undefined {
  if (segments.length !== 3 || segments[0]?.toLowerCase() !== GROUPS) return undefined;
  let publisher: string;
  let slug: string;
  try {
    publisher = decodeURIComponent(segments[1] ?? "");
    slug = decodeURIComponent(segments[2] ?? "");
  } catch {
    return undefined;
  }
  if (!valid(publisher, 39) || !GROUP_SLUG.test(slug) || slug.length > GROUP_SLUG_MAX)
    return undefined;
  return { publisher, slug };
}

/** The non-empty segments of a URL path. */
export const segmentsOf = (pathname: string) => pathname.split("/").filter(Boolean);
