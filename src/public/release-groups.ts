import { picks, type SettingPick } from "./directory.js";
import { GROUP_SLUG_MAX } from "./paths.js";
import { frontierOf } from "./release-rule.js";
import type {
  PublishedLine,
  PublishedRelease,
  ReleasePublisher,
  ReleaseRepository,
  ReleaseSetting,
} from "./release-types.js";

/**
 * Repository groups as selfbench.dev shows them. A group is a workspace's named set of
 * repositories; its page pools each member's current release by that workspace into one
 * leaderboard. Only settings released on every member are pooled, so every pooled score covers
 * the same tasks: each member's whole task set.
 */

/** What the public snapshot reads of a stored group. */
export interface GroupRecord {
  publisherLogin: string;
  /**
   * Every login the group's workspace has released under. A renamed workspace's current
   * releases keep the login they were written with, so members match on any of them.
   */
  releaseLogins?: readonly string[];
  slug: string;
  name: string;
  description: string;
  repositoryIds: readonly number[];
  updatedAt: string;
}

/** One setting's own score on one member, beside its pooled score. */
interface MemberScore {
  passed: number;
  tasks: number;
  accuracy: number;
  costPerTaskUsd: number;
  costedTasks?: number;
}

/** A member repository of a group, as of its current release by the group's publisher. */
export interface GroupMember {
  repository: Pick<
    ReleaseRepository,
    "id" | "fullName" | "description" | "stars" | "ownerAvatarUrl"
  >;
  releaseId: string;
  releasedAt: string;
  tasks: number;
  /** How many settings its own release has, pooled or not. */
  settings: number;
  /** Each pooled setting's score on this member alone, by setting id. */
  scores: Record<string, MemberScore>;
}

/** A group's page: its members, and the settings they share, scored over all their tasks. */
export interface PublishedGroup {
  publisher: ReleasePublisher;
  slug: string;
  name: string;
  description?: string;
  /** When the group itself or any member's release last changed. */
  updatedAt: string;
  members: GroupMember[];
  /** Every member's tasks together. */
  tasks: number;
  /** Settings released on every member, pooled; empty when the members share none. */
  settings: ReleaseSetting[];
  frontier: string[];
}

/** A group on the home page: what its card shows. */
export interface GroupCard {
  publisher: ReleasePublisher;
  slug: string;
  name: string;
  description?: string;
  updatedAt: string;
  repositories: string[];
  tasks: number;
  settings: number;
  picks: SettingPick<Pick<ReleaseSetting, "id" | "model" | "accuracy" | "costPerTaskUsd">>[];
}

/** A group's address on selfbench.dev, in its publisher's own spelling. */
export const groupHref = (publisher: string, slug: string) =>
  `/groups/${encodeURIComponent(publisher)}/${encodeURIComponent(slug)}`;

/** A slug made from a name: `Python Web Frameworks` gives `python-web-frameworks`. */
export function slugOf(name: string): string {
  return (
    name
      .normalize("NFKD")
      // Accents come apart from their letters; drop them rather than split the word.
      .replace(/\p{Mn}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, GROUP_SLUG_MAX)
      .replace(/-+$/, "")
  );
}

/** Where a release without `costedTasks` stands: a legacy release priced every task it ran. */
const costed = (setting: ReleaseSetting) => setting.costedTasks ?? setting.tasks;

const scoreOf = (setting: ReleaseSetting): MemberScore => ({
  passed: setting.passed,
  tasks: setting.tasks,
  accuracy: setting.accuracy,
  costPerTaskUsd: setting.costPerTaskUsd,
  ...(setting.costedTasks !== undefined ? { costedTasks: setting.costedTasks } : {}),
});

/**
 * Each setting on every release, scored over all their tasks: passed over tasks, and the priced
 * tasks' spend over their count, as a single release scores its own (`scores` in
 * release-rule.ts). The frontier is drawn again over the pooled scores.
 */
export function pooledSettings(releases: readonly PublishedRelease[]): ReleaseSetting[] {
  const [first, ...rest] = releases;
  if (!first) return [];
  const shared = first.settings.filter((setting) =>
    rest.every((release) => release.settings.some((other) => other.id === setting.id)),
  );
  const pooled = shared.map((setting) => {
    const each = releases.flatMap(
      (release) => release.settings.find((other) => other.id === setting.id) ?? [],
    );
    const tasks = each.reduce((sum, one) => sum + one.tasks, 0);
    const passed = each.reduce((sum, one) => sum + one.passed, 0);
    const totalCostUsd = each.reduce((sum, one) => sum + one.totalCostUsd, 0);
    const costedTasks = each.reduce((sum, one) => sum + costed(one), 0);
    // One sign-in type only when every member used it; a mix is left unsaid, as combined
    // releases leave it.
    const { signIn, ...described } = setting;
    const sameSignIn = signIn !== undefined && each.every((one) => one.signIn === signIn);
    return {
      ...described,
      ...(sameSignIn ? { signIn } : {}),
      tasks,
      passed,
      accuracy: tasks > 0 ? (passed / tasks) * 100 : 0,
      costPerTaskUsd: costedTasks > 0 ? totalCostUsd / costedTasks : 0,
      totalCostUsd,
      costedTasks,
      onFrontier: false,
    };
  });
  const frontier = frontierOf(pooled.filter((setting) => setting.costedTasks > 0));
  return pooled.map((setting) => ({ ...setting, onFrontier: frontier.has(setting.id) }));
}

const newest = (dates: readonly string[]) =>
  dates.reduce((latest, date) => (date > latest ? date : latest));

/**
 * A group's page from the current lines, or undefined when none of its members has a current
 * release by its publisher. A member without one is left out until it is released again.
 */
export function groupOf(
  group: GroupRecord,
  lines: readonly PublishedLine[],
): PublishedGroup | undefined {
  const logins = new Set(
    [group.publisherLogin, ...(group.releaseLogins ?? [])].map((login) => login.toLowerCase()),
  );
  const releases = group.repositoryIds.flatMap((id) => {
    const line = lines.find(
      (each) =>
        each.release.repository.id === id && logins.has(each.release.publisher.login.toLowerCase()),
    );
    return line ? [line.release] : [];
  });
  const [first] = releases;
  if (!first) return undefined;
  const settings = pooledSettings(releases);
  const members = releases.map((release): GroupMember => {
    const { id, fullName, description, stars, ownerAvatarUrl } = release.repository;
    return {
      repository: {
        id,
        fullName,
        ...(description === undefined ? {} : { description }),
        ...(stars === undefined ? {} : { stars }),
        ...(ownerAvatarUrl === undefined ? {} : { ownerAvatarUrl }),
      },
      releaseId: release.releaseId,
      releasedAt: release.releasedAt,
      tasks: release.tasks,
      settings: release.settings.length,
      scores: Object.fromEntries(
        release.settings
          .filter((setting) => settings.some((pooled) => pooled.id === setting.id))
          .map((setting) => [setting.id, scoreOf(setting)]),
      ),
    };
  });
  return {
    publisher: first.publisher,
    slug: group.slug,
    name: group.name,
    ...(group.description ? { description: group.description } : {}),
    updatedAt: newest([group.updatedAt, ...releases.map((release) => release.releasedAt)]),
    members,
    tasks: releases.reduce((sum, release) => sum + release.tasks, 0),
    settings,
    frontier: settings.filter((setting) => setting.onFrontier).map((setting) => setting.id),
  };
}

/**
 * The pooled setting most accurate on one member alone; the cheaper one there breaks a tie.
 */
export function mostAccurate(
  group: Pick<PublishedGroup, "settings">,
  member: Pick<GroupMember, "scores">,
): { id: string; label: string; accuracy: number } | undefined {
  let best: { id: string; label: string; accuracy: number; cost: number } | undefined;
  for (const setting of group.settings) {
    const score = member.scores[setting.id];
    if (!score) continue;
    if (
      !best ||
      score.accuracy > best.accuracy ||
      (score.accuracy === best.accuracy && score.costPerTaskUsd < best.cost)
    )
      best = {
        id: setting.id,
        label: setting.model.label,
        accuracy: score.accuracy,
        cost: score.costPerTaskUsd,
      };
  }
  return best && { id: best.id, label: best.label, accuracy: best.accuracy };
}

/** A group reduced to its home page card. */
export function groupCardOf(group: PublishedGroup): GroupCard {
  return {
    publisher: group.publisher,
    slug: group.slug,
    name: group.name,
    ...(group.description ? { description: group.description } : {}),
    updatedAt: group.updatedAt,
    repositories: group.members.map((member) => member.repository.fullName),
    tasks: group.tasks,
    settings: group.settings.length,
    picks: picks(group.settings).map((pick) => ({
      roles: pick.roles,
      setting: {
        id: pick.setting.id,
        model: pick.setting.model,
        accuracy: pick.setting.accuracy,
        costPerTaskUsd: pick.setting.costPerTaskUsd,
      },
    })),
  };
}

/** Every group with something to show, most recently changed first. */
export function groupsOf(
  groups: readonly GroupRecord[],
  lines: readonly PublishedLine[],
): PublishedGroup[] {
  return groups
    .flatMap((group) => groupOf(group, lines) ?? [])
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        `${left.publisher.login}/${left.slug}`.localeCompare(
          `${right.publisher.login}/${right.slug}`,
        ),
    );
}
