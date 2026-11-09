import { directoryOf } from "../../../src/public/directory";
import { resultsName } from "../../../src/public/paths";
import { groupCardOf } from "../../../src/public/release-groups";
import type {
  PublicGroup,
  PublicGroupCard,
  PublicRepoPage,
  PublicRepoSummary,
  PublicTask,
  PublicTaskFiles,
  PublicTrial,
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
  /**
   * A repository's (or public benchmark's) default line, by its address name (`resultsName`:
   * `owner/name`, or `evals/org/name`), or undefined when nothing has been released for it.
   */
  getRepo(name: string): Promise<PublicRepoPage | undefined>;
  /** One publisher's line of a repository or public benchmark. */
  getLine(name: string, publisher: string): Promise<PublicRepoPage | undefined>;
  /** A release's tasks, or undefined when its publisher did not publish them. */
  getTasks(releaseId: string): Promise<PublicTask[] | undefined>;
  /** One published task's files, or undefined when the release has no such task. */
  getTaskFiles(releaseId: string, taskId: string): Promise<PublicTaskFiles | undefined>;
  /** Where a published task downloads from, as a `.tar.gz` named after it. */
  taskDownloadUrl(releaseId: string, taskId: string): string;
  /** One setting's trial on a task, or undefined when the release did not publish it. */
  getTrial(releaseId: string, taskId: string, settingId: string): Promise<PublicTrial | undefined>;
  /** Every repository group with something to show, most recently changed first. */
  listGroups(): Promise<PublicGroupCard[]>;
  /** One repository group's page, or undefined when it has nothing to show. */
  getGroup(publisher: string, slug: string): Promise<PublicGroup | undefined>;
}

/**
 * Published tasks held in memory, by release id: each task's files by its id, and its trials by
 * task id, then setting id.
 */
export type MemoryTasks = Record<
  string,
  {
    tasks: PublicTask[];
    files: Record<string, PublicTaskFiles>;
    trials?: Record<string, Record<string, PublicTrial>>;
  }
>;

const sameName = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/**
 * A source over pages held in memory. One page per release line. A repository's default
 * line is its endorsed line, else its most recently released one, for the directory and the
 * repository page alike. The directory's cards are built exactly as the server builds them, and
 * `groups` are the groups' current releases. Used by tests and the local fixture loader.
 */
export function memorySource(
  pages: readonly PublicRepoPage[],
  published: MemoryTasks = {},
  groups: readonly PublicGroup[] = [],
): PublicSource {
  const newestFirst = (candidates: readonly PublicRepoPage[]) =>
    [...candidates].sort((left, right) =>
      right.release.releasedAt.localeCompare(left.release.releasedAt),
    );
  const linesOf = (name: string) =>
    newestFirst(pages.filter((page) => sameName(resultsName(page.release), name)));
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
    async getRepo(name) {
      const lines = linesOf(name);
      const page = defaultLine(lines);
      return page ? withLines(page, lines) : undefined;
    },
    async getLine(name, publisher) {
      const lines = linesOf(name);
      const page = lines.find((line) => sameName(line.release.publisher.login, publisher));
      return page ? withLines(page, lines) : undefined;
    },
    async getTasks(releaseId) {
      return published[releaseId]?.tasks;
    },
    async getTaskFiles(releaseId, taskId) {
      return published[releaseId]?.files[taskId];
    },
    // Held in memory, there is no archive: the link names one the way the API would.
    taskDownloadUrl: (releaseId, taskId) => `#download/${releaseId}/${taskId}.tar.gz`,
    async getTrial(releaseId, taskId, settingId) {
      return published[releaseId]?.trials?.[taskId]?.[settingId];
    },
    async listGroups() {
      return groups.map(groupCardOf);
    },
    async getGroup(publisher, slug) {
      return groups.find(
        (group) => sameName(group.publisher.login, publisher) && group.slug === slug,
      );
    },
  };
}
