import { directoryOf } from "../../../src/public/directory";
import type { PublicRepoPage, PublicRepoSummary } from "./contract";

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
}

const sameName = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/**
 * A source over pages held in memory. One page per release line. A repository's default
 * line is its endorsed line, else its most recently released one, for the directory and the
 * repository page alike. The directory's cards are built exactly as the server builds them.
 * Used by tests and the local fixture loader.
 */
export function memorySource(pages: readonly PublicRepoPage[]): PublicSource {
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
  };
}
