import type { DirectoryCard } from "../../../src/public/directory";
import type {
  GroupCard,
  GroupMember,
  GroupRecord,
  PublishedGroup,
} from "../../../src/public/release-groups";
import type {
  PublishedRelease,
  PublishedTask,
  PublishedTaskFiles,
  PublishedTrial,
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
/** A task of a release whose publisher published the tasks. */
export type PublicTask = PublishedTask;
/** A published task's files: small text files with their contents, the rest by size. */
export type PublicTaskFiles = PublishedTaskFiles;
/** One setting's trial on a task of a release that published its trials: result and transcript. */
export type PublicTrial = PublishedTrial;

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

/** A repository group's page: its members, and the settings they share pooled over their tasks. */
export type PublicGroup = PublishedGroup;
/** One member repository of a group, with each pooled setting's score on it alone. */
export type PublicGroupMember = GroupMember;
/** A repository group as the home page lists it. */
export type PublicGroupCard = GroupCard;
/** A stored group, as the in-memory source builds pages from it, as the server does. */
export type PublicGroupRecord = GroupRecord;
