import type { DirectoryCard, SettingPick } from "../../../src/public/directory";
import type {
  PublishedRelease,
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

/** A frontier setting singled out on the picks strip, with every role it holds. */
export type PublicPick = SettingPick<PublicSetting>;

/**
 * One entry of the home page directory: a release line reduced to its card, as the server
 * builds it (`src/public/directory.ts`), with only what a card and the search show.
 */
export type PublicRepoSummary = DirectoryCard;
