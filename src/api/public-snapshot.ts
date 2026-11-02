import { directoryOf } from "../public/directory.js";
import { groupCardOf, type PublishedGroup } from "../public/release-groups.js";
import type { PublishedLine, PublishedRelease } from "../public/release-types.js";
import { type TaggedBody, tagged } from "./tagged.js";

/**
 * Every current release line and repository group, as read at one moment, with the public
 * responses built from them. Each response is built and tagged the first time it is asked for,
 * then reused until the next read, so a request costs no read of the tables and a client or CDN
 * already holding a response is answered with a bodyless 304.
 */
export interface Snapshot {
  /** Current lines by lower-case repository name, newest first. */
  byRepository: Map<string, PublishedLine[]>;
  /** Current releases by id. */
  byRelease: Map<string, PublishedRelease>;
  /** Every group's current release, newest first. */
  groups: PublishedGroup[];
  releases: () => TaggedBody;
  directory: () => TaggedBody;
  /** One repository's response, or undefined when nothing is released for it. */
  repository: (fullName: string) => TaggedBody | undefined;
  /** One group, or undefined when it has nothing to show. */
  group: (publisher: string, slug: string) => PublishedGroup | undefined;
  /** One group's response, or undefined when it has nothing to show. */
  groupBody: (publisher: string, slug: string) => TaggedBody | undefined;
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

export function snapshotOf(lines: PublishedLine[], groups: PublishedGroup[] = []): Snapshot {
  const byRepository = new Map<string, PublishedLine[]>();
  for (const line of lines) {
    const key = line.release.repository.fullName.toLowerCase();
    byRepository.set(key, [...(byRepository.get(key) ?? []), line]);
  }
  const byGroup = new Map(
    groups.map((group) => [groupKey(group.publisher.login, group.slug), group]),
  );
  const repositoryBodies = keptBodies<{ lines: PublishedLine[] }>();
  const groupBodies = keptBodies<{ group: PublishedGroup }>();
  const group = (publisher: string, slug: string) => byGroup.get(groupKey(publisher, slug));
  return {
    byRepository,
    byRelease: new Map(lines.map((line) => [line.release.releaseId, line.release])),
    groups,
    releases: once(() => tagged(JSON.stringify({ lines }))),
    directory: once(() =>
      tagged(JSON.stringify({ cards: directoryOf(lines), groups: groups.map(groupCardOf) })),
    ),
    repository(fullName) {
      const key = fullName.toLowerCase();
      const found = byRepository.get(key);
      return repositoryBodies(key, found && { lines: found });
    },
    group,
    groupBody(publisher, slug) {
      const found = group(publisher, slug);
      return groupBodies(groupKey(publisher, slug), found && { group: found });
    },
  };
}
