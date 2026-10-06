import { directoryOf, groupCardsOf } from "../../../src/public/directory";
import type {
  PublicGroupRelease,
  PublicGroupSummary,
  PublicRepoPage,
  PublicRepoSummary,
  PublicTask,
  PublicTaskFiles,
} from "./contract";

/**
 * Where public pages get their data. Pages call only this. Fixtures implement it during
 * development; the public API implements it later, with no page changes.
 */
export interface PublicSource {
  /** Each repository's default line, as directory cards, newest release first. */
  listRepos(): Promise<PublicRepoSummary[]>;
  /** Every release line as a card, newest first. Search shows one result per line. */
  listLines(): Promise<PublicRepoSummary[]>;
  /** A repository's default line, or undefined when nothing has been released for it. */
  getRepo(owner: string, name: string): Promise<PublicRepoPage | undefined>;
  /** One publisher's line of a repository. */
  getLine(owner: string, name: string, publisher: string): Promise<PublicRepoPage | undefined>;
  /** Every group's current release as a card, newest first. */
  listGroups(): Promise<PublicGroupSummary[]>;
  /** A group's current release, or undefined when it has none. */
  getGroup(slug: string): Promise<PublicGroupRelease | undefined>;
  /** A release's tasks, or undefined when its publisher did not publish them. */
  getTasks(releaseId: string): Promise<PublicTask[] | undefined>;
  /** One published task's files, or undefined when the release has no such task. */
  getTaskFiles(releaseId: string, taskId: string): Promise<PublicTaskFiles | undefined>;
  /** Where a published task downloads from, as a `.tar.gz` named after it. */
  taskDownloadUrl(releaseId: string, taskId: string): string;
}

/** Published tasks held in memory, by release id: each task's files by its id. */
export type MemoryTasks = Record<
  string,
  { tasks: PublicTask[]; files: Record<string, PublicTaskFiles> }
>;

const sameName = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/**
 * A source over pages held in memory. One page per release line. A repository's default
 * line is its endorsed line, else its most recently released one, for the directory and the
 * repository page alike. The directory's cards, a repository's or a group's, are built exactly as
 * the server builds them.
 * Used by tests and the local fixture loader.
 */
export function memorySource(
  pages: readonly PublicRepoPage[],
  published: MemoryTasks = {},
  groups: readonly PublicGroupRelease[] = [],
): PublicSource {
  const newestFirst = (candidates: readonly PublicRepoPage[]) =>
    [...candidates].sort((left, right) =>
      right.release.releasedAt.localeCompare(left.release.releasedAt),
    );
  const linesOf = (owner: string, name: string) =>
    newestFirst(
      pages.filter((page) => sameName(page.release.repository.fullName, `${owner}/${name}`)),
    );
  const defaultLine = (lines: readonly PublicRepoPage[]) =>
    lines.find((line) => line.endorsed) ?? lines[0];
  const withLines = (page: PublicRepoPage, lines: PublicRepoPage[]): PublicRepoPage => ({
    ...page,
    lines: lines.map((line) => ({
      publisher: line.release.publisher,
      releaseId: line.release.releaseId,
      releasedAt: line.release.releasedAt,
      tasks: line.release.tasks,
      settings: line.release.settings.length,
      endorsed: line.endorsed,
    })),
  });
  const cards = () =>
    directoryOf(pages.map((page) => ({ release: page.release, endorsed: page.endorsed })));
  return {
    async listRepos() {
      return cards().filter((card) => card.defaultLine);
    },
    async listLines() {
      return cards();
    },
    async getRepo(owner, name) {
      const lines = linesOf(owner, name);
      const page = defaultLine(lines);
      return page ? withLines(page, lines) : undefined;
    },
    async getLine(owner, name, publisher) {
      const lines = linesOf(owner, name);
      const page = lines.find((line) => sameName(line.release.publisher.login, publisher));
      return page ? withLines(page, lines) : undefined;
    },
    async listGroups() {
      return groupCardsOf(groups);
    },
    async getGroup(slug) {
      return groups.find((release) => sameName(release.group.slug, slug));
    },
    async getTasks(releaseId) {
      return published[releaseId]?.tasks;
    },
    async getTaskFiles(releaseId, taskId) {
      return published[releaseId]?.files[taskId];
    },
    // Held in memory, there is no archive: the link names one the way the API would.
    taskDownloadUrl: (releaseId, taskId) => `#download/${releaseId}/${taskId}.tar.gz`,
  };
}
