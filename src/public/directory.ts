import type {
  PublishedGroupRelease,
  PublishedLine,
  ReleasePublisher,
  ReleaseRepository,
  ReleaseSetting,
} from "./release-types.js";

/**
 * The home page directory of selfbench.dev: one card per release line, holding only what a
 * card and the search show. The server builds it for the public API, and the site builds the
 * same cards from local data in development.
 */

export type PickRole = "cheapest" | "mostAccurate";

/** A frontier setting singled out on cards and the picks strip, with every role it holds. */
export interface SettingPick<S> {
  setting: S;
  roles: PickRole[];
}

/** What a card shows of a setting: its name and its two numbers. */
interface CardSetting {
  id: string;
  model: { label: string };
  accuracy: number;
  costPerTaskUsd: number;
}

/** How many lines a card's hover preview has (RepoCard's PREVIEW_LINES). */
const PREVIEW_LINES = 5;

/** One release line, reduced to its card. */
export interface DirectoryCard {
  repository: Pick<
    ReleaseRepository,
    "id" | "fullName" | "description" | "stars" | "ownerAvatarUrl"
  >;
  publisher: ReleasePublisher;
  releaseId: string;
  releasedAt: string;
  tasks: number;
  settings: number;
  /** The cheapest and the most accurate frontier settings. */
  picks: SettingPick<CardSetting>[];
  /** Every frontier setting, cheapest first, for the card's hover preview. */
  frontier: CardSetting[];
  /**
   * The most accurate settings off the frontier, most accurate first, as many as the hover
   * preview has lines: it lists them below the frontier, in the lines the frontier leaves.
   */
  others: CardSetting[];
  endorsed: boolean;
  /** The line the repository shows by default: its endorsed line, else its newest. */
  defaultLine: boolean;
}

type Ranked = Pick<ReleaseSetting, "id" | "accuracy" | "costPerTaskUsd" | "onFrontier">;

/** Frontier settings, cheapest first; accuracy breaks cost ties, then id. */
export function frontierSettings<S extends Ranked>(settings: readonly S[]): S[] {
  return settings
    .filter((setting) => setting.onFrontier)
    .sort(
      (left, right) =>
        left.costPerTaskUsd - right.costPerTaskUsd ||
        right.accuracy - left.accuracy ||
        left.id.localeCompare(right.id),
    );
}

/**
 * The two picks a card names: the cheapest frontier setting and the most accurate one. When
 * one setting is both, it appears once with both roles. The rest of the frontier lives on
 * the repository page's chart.
 */
export function picks<S extends Ranked>(settings: readonly S[]): SettingPick<S>[] {
  const frontier = frontierSettings(settings);
  const cheapest = frontier[0];
  const mostAccurate = [...frontier].sort(
    (left, right) =>
      right.accuracy - left.accuracy ||
      left.costPerTaskUsd - right.costPerTaskUsd ||
      left.id.localeCompare(right.id),
  )[0];
  if (!cheapest || !mostAccurate) return [];
  if (cheapest.id === mostAccurate.id)
    return [{ setting: cheapest, roles: ["cheapest", "mostAccurate"] }];
  return [
    { setting: cheapest, roles: ["cheapest"] },
    { setting: mostAccurate, roles: ["mostAccurate"] },
  ];
}

/** The most accurate frontier setting, as a page's description names it first. */
export function leadingSetting<S extends Ranked>(settings: readonly S[]): S | undefined {
  return [...frontierSettings(settings)].sort(
    (left, right) =>
      right.accuracy - left.accuracy ||
      left.costPerTaskUsd - right.costPerTaskUsd ||
      left.id.localeCompare(right.id),
  )[0];
}

/** Settings off the frontier, most accurate first; cost breaks accuracy ties, then id. */
export function offFrontier<S extends Ranked>(settings: readonly S[]): S[] {
  return settings
    .filter((setting) => !setting.onFrontier)
    .sort(
      (left, right) =>
        right.accuracy - left.accuracy ||
        left.costPerTaskUsd - right.costPerTaskUsd ||
        left.id.localeCompare(right.id),
    );
}

const cardSetting = (setting: ReleaseSetting): CardSetting => ({
  id: setting.id,
  model: { label: setting.model.label },
  accuracy: setting.accuracy,
  costPerTaskUsd: setting.costPerTaskUsd,
});

/** What a card shows of any release, a repository's or a group's: its counts and settings. */
function cardSettings(release: Pick<PublishedGroupRelease, "tasks" | "settings">) {
  return {
    tasks: release.tasks,
    settings: release.settings.length,
    picks: picks(release.settings).map((pick) => ({ ...pick, setting: cardSetting(pick.setting) })),
    frontier: frontierSettings(release.settings).map(cardSetting),
    others: offFrontier(release.settings).slice(0, PREVIEW_LINES).map(cardSetting),
  };
}

function cardOf(line: PublishedLine, defaultLine: boolean): DirectoryCard {
  const { release } = line;
  const { id, fullName, description, stars, ownerAvatarUrl } = release.repository;
  return {
    repository: {
      id,
      fullName,
      ...(description === undefined ? {} : { description }),
      ...(stars === undefined ? {} : { stars }),
      ...(ownerAvatarUrl === undefined ? {} : { ownerAvatarUrl }),
    },
    publisher: release.publisher,
    releaseId: release.releaseId,
    releasedAt: release.releasedAt,
    ...cardSettings(release),
    endorsed: line.endorsed,
    defaultLine,
  };
}

/**
 * Every line as a card, newest release first (release id breaks ties, so the same lines always
 * give the same order). Each repository's default line is marked: the home page lists those,
 * and search covers every card.
 */
export function directoryOf(lines: readonly PublishedLine[]): DirectoryCard[] {
  const ordered = [...lines].sort(
    (left, right) =>
      right.release.releasedAt.localeCompare(left.release.releasedAt) ||
      left.release.releaseId.localeCompare(right.release.releaseId),
  );
  const defaults = new Map<number, PublishedLine>();
  for (const line of ordered) {
    const id = line.release.repository.id;
    const chosen = defaults.get(id);
    if (!chosen || (line.endorsed && !chosen.endorsed)) defaults.set(id, line);
  }
  const chosen = new Set(defaults.values());
  return ordered.map((line) => cardOf(line, chosen.has(line)));
}

/** A group's current release, reduced to its card. */
export interface GroupCard extends Omit<DirectoryCard, "repository" | "endorsed" | "defaultLine"> {
  group: {
    slug: string;
    name: string;
    members: Pick<ReleaseRepository, "id" | "fullName" | "ownerAvatarUrl">[];
  };
}

/** Every group's current release as a card, newest first (release id breaks ties). */
export function groupCardsOf(releases: readonly PublishedGroupRelease[]): GroupCard[] {
  return [...releases]
    .sort(
      (left, right) =>
        right.releasedAt.localeCompare(left.releasedAt) ||
        left.releaseId.localeCompare(right.releaseId),
    )
    .map((release) => ({
      group: {
        slug: release.group.slug,
        name: release.group.name,
        members: release.group.members.map(({ id, fullName, ownerAvatarUrl }) => ({
          id,
          fullName,
          ...(ownerAvatarUrl === undefined ? {} : { ownerAvatarUrl }),
        })),
      },
      publisher: release.publisher,
      releaseId: release.releaseId,
      releasedAt: release.releasedAt,
      ...cardSettings(release),
    }));
}
