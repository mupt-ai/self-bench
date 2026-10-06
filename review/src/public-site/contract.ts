import type { DirectoryCard, GroupCard } from "../../../src/public/directory";
import type {
  PublishedGroupRelease,
  PublishedRelease,
  PublishedTask,
  PublishedTaskFiles,
  ReleasePublisher,
  ReleaseSetting,
} from "../../../src/public/release-types";

/**
 * The public data contract: what selfbench.dev pages consume. The release shapes are the
 * server's (`src/public/release-types.ts`), named here for the pages; the rest are the site's
 * own views of them.
 */
export { RELEASE_SCHEMA_VERSION as PUBLIC_SCHEMA_VERSION } from "../../../src/public/release-types";

export type PublicPublisher = ReleasePublisher;
export type PublicSetting = ReleaseSetting;
/** One release of one repository by one publisher: the unit a repository page shows. */
export type PublicRelease = PublishedRelease;
/** One release of a group of repositories: one benchmark over all their tasks. */
export type PublicGroupRelease = PublishedGroupRelease;
/** What the task list and viewer read of a release, a repository's or a group's. */
export type TaskRelease = Pick<PublicRelease, "releaseId" | "tasks"> & {
  repository?: Pick<PublicRelease["repository"], "fullName">;
};
/** A task of a release whose publisher published the tasks. */
export type PublicTask = PublishedTask;
/** A published task's files: small text files with their contents, the rest by size. */
export type PublicTaskFiles = PublishedTaskFiles;

/** One release line of a repository, for the switcher and search results. */
interface PublicLineSummary {
  publisher: PublicPublisher;
  releaseId: string;
  releasedAt: string;
  tasks: number;
  settings: number;
  endorsed: boolean;
}

/** What a repository page needs: the shown release plus every line the repository has. */
export interface PublicRepoPage {
  release: PublicRelease;
  endorsed: boolean;
  lines: PublicLineSummary[];
}

export type { PickRole } from "../../../src/public/directory";

/**
 * One entry of the home page directory: a release line reduced to its card, as the server
 * builds it (`src/public/directory.ts`), with only what a card and the search show.
 */
export type PublicRepoSummary = DirectoryCard;

/** A group's current release, reduced to its card on the home page. */
export type PublicGroupSummary = GroupCard;
