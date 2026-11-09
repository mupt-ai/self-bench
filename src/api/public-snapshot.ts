import { directoryOf } from "../public/directory.js";
import { resultsName } from "../public/paths.js";
import { groupCardOf, groupLogoHref, type PublishedGroup } from "../public/release-groups.js";
import type { PublishedLine, PublishedRelease, ReleasePublished } from "../public/release-types.js";
import { type TaggedBody, tagged } from "./tagged.js";

/**
 * Every current release line and repository group, as read at one moment, with the public
 * responses built from them. Each response is built and tagged the first time it is asked for,
 * then reused until the next read, so a request costs no read of the tables and a client or CDN
 * already holding a response is answered with a bodyless 304.
 */
export interface Snapshot {
  /** Current lines by lower-case `resultsName` (`owner/name`, `evals/org/name`), newest first. */
  byRepository: Map<string, PublishedLine[]>;
  /**
   * Current releases by id, a group's too, with what each published beyond its scores: the
   * public task routes serve only what a current release published.
   */
  byRelease: Map<string, Pick<PublishedRelease, "releaseId"> & ReleasePublished>;
  /** Every group's current release, newest first. */
  groups: PublishedGroup[];
  releases: () => TaggedBody;
  directory: () => TaggedBody;
  /** One repository's or benchmark's response, by `resultsName`, or undefined when none. */
  repository: (name: string) => TaggedBody | undefined;
  /** One group, or undefined when it has nothing to show. */
  group: (publisher: string, slug: string) => PublishedGroup | undefined;
  /** One group's response, or undefined when it has nothing to show. */
  groupBody: (publisher: string, slug: string) => TaggedBody | undefined;
  /** One group's logo as its publisher uploaded it (a data URL), or undefined when it has none. */
  logo: (publisher: string, slug: string) => string | undefined;
}

/** `build`, run once on first use. */
function once<T>(build: () => T): () => T {
  let built: { value: T } | undefined;
  return () => {
    built ??= { value: build() };
    return built.value;
  };
}

const groupKey = (publisher: string, slug: string) => `${publisher.toLowerCase()}/${slug}`;

/** Builds a response once per key and keeps it for the snapshot's life. */
function keptBodies<T>(): (key: string, value: T | undefined) => TaggedBody | undefined {
  const bodies = new Map<string, TaggedBody>();
  return (key, value) => {
    if (value === undefined) return undefined;
    let body = bodies.get(key);
    if (!body) {
      body = tagged(JSON.stringify(value));
      bodies.set(key, body);
    }
    return body;
  };
}

export function snapshotOf(lines: PublishedLine[], released: PublishedGroup[] = []): Snapshot {
  let groups = released;
  const byRepository = new Map<string, PublishedLine[]>();
  for (const line of lines) {
    const key = resultsName(line.release).toLowerCase();
    byRepository.set(key, [...(byRepository.get(key) ?? []), line]);
  }
  // A deleted group's address can be reused; only the newest release at an address is shown. Its
  // logo is served on its own (`logo`), so what is served of the group names only its address.
  const byGroup = new Map<string, PublishedGroup>();
  const logos = new Map<string, string>();
  for (const group of groups) {
    const key = groupKey(group.publisher.login, group.slug);
    if (byGroup.has(key)) continue;
    if (group.logo) logos.set(key, group.logo);
    byGroup.set(key, group.logo ? { ...group, logo: groupLogoHref(group) } : group);
  }
  groups = [...byGroup.values()];
  const repositoryBodies = keptBodies<{ lines: PublishedLine[] }>();
  const groupBodies = keptBodies<{ group: PublishedGroup }>();
  const group = (publisher: string, slug: string) => byGroup.get(groupKey(publisher, slug));
  return {
    byRepository,
    byRelease: new Map(
      [...lines.map((line) => line.release), ...groups].map((release) => [
        release.releaseId,
        release,
      ]),
    ),
    groups,
    releases: once(() => tagged(JSON.stringify({ lines }))),
    directory: once(() =>
      tagged(JSON.stringify({ cards: directoryOf(lines), groups: groups.map(groupCardOf) })),
    ),
    repository(name) {
      const key = name.toLowerCase();
      const found = byRepository.get(key);
      return repositoryBodies(key, found && { lines: found });
    },
    group,
    logo: (publisher, slug) => logos.get(groupKey(publisher, slug)),
    groupBody(publisher, slug) {
      const found = group(publisher, slug);
      return groupBodies(groupKey(publisher, slug), found && { group: found });
    },
  };
}
