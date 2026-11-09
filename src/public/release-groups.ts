import {
  type CardSetting,
  cardSetting,
  frontierSettings,
  offFrontier,
  PREVIEW_LINES,
  picks,
  type SettingPick,
} from "./directory.js";
import { GROUP_SLUG_MAX } from "./paths.js";
import type { ReleasePublisher, ReleaseRepository, ReleaseSetting } from "./release-types.js";

/**
 * Repository groups as selfbench.dev shows them. A group is a workspace's named set of
 * repositories, evaluated together like one repository: its release scores each setting over
 * every member's tasks, and lists how each did on each member.
 */

/** One setting's score on one member's tasks alone, beside its score over the group. */
interface MemberScore {
  passed: number;
  tasks: number;
  accuracy: number;
  costPerTaskUsd: number;
  costedTasks: number;
}

/** A member repository of a released group. */
export interface GroupMember {
  repository: Pick<
    ReleaseRepository,
    "id" | "fullName" | "description" | "stars" | "ownerAvatarUrl"
  >;
  /** How many of the release's tasks are this member's. */
  tasks: number;
  /** Each released setting's score on this member's tasks, by setting id. */
  scores: Record<string, MemberScore>;
}

/** What a group release row stores in `payload`: everything public but its id and time. */
export interface GroupReleasePayload {
  publisher: ReleasePublisher;
  slug: string;
  name: string;
  description?: string;
  /** The group's logo as a data URL; absent for the default mark. */
  logo?: string;
  members: GroupMember[];
  /** Every member's released tasks together. */
  tasks: number;
  settings: ReleaseSetting[];
  frontier: string[];
}

/** A group's current release, as served. */
export interface PublishedGroup extends GroupReleasePayload {
  releaseId: string;
  /** When it was released. */
  updatedAt: string;
}

/** A group on the home page: what its card shows. */
export interface GroupCard {
  publisher: ReleasePublisher;
  slug: string;
  name: string;
  description?: string;
  logo?: string;
  updatedAt: string;
  repositories: string[];
  tasks: number;
  settings: number;
  picks: SettingPick<CardSetting>[];
  /** Every frontier setting, cheapest first, for the card's hover preview. */
  frontier: CardSetting[];
  /** The most accurate settings off the frontier, for the preview lines the frontier leaves. */
  others: CardSetting[];
}

/** The mark a group shows until its publisher uploads a logo. */
export const DEFAULT_GROUP_LOGO = "/dari-logo.svg";

/**
 * A group's logo: a small image as a data URL, served inline with the release. Images only,
 * under 48 KB, so the release stays small.
 */
export const GROUP_LOGO = {
  maxBytes: 48 * 1024,
  types: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"] as const,
};

/** Whether a value is a data URL of an allowed image type, small enough to store and serve. */
export function isGroupLogo(value: string): boolean {
  const match = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/]+=*)$/.exec(value);
  if (!match || !(GROUP_LOGO.types as readonly string[]).includes(match[1] ?? "")) return false;
  return Math.floor(((match[2]?.length ?? 0) * 3) / 4) <= GROUP_LOGO.maxBytes;
}

/**
 * Where a released group's logo is served (public-releases.ts), so pages carry this short
 * address rather than the image: a directory of many groups would otherwise carry every image.
 * The release id in it changes with the logo, so an old one is never shown in its place.
 */
export const groupLogoHref = (group: Pick<PublishedGroup, "publisher" | "slug" | "releaseId">) =>
  `/api/public${groupHref(group.publisher.login, group.slug)}/logo?v=${encodeURIComponent(group.releaseId)}`;

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

/** One released setting's trial on one task, as a release's detail records it. */
interface TaskResult {
  pass: boolean;
  costUsd?: number;
}

/**
 * Each member's share of a release: its tasks, and each setting's score on them alone, from the
 * per-task results the release recorded (`detail.results`, by setting key then task key).
 * `owner` names the member (its GitHub id) each task key belongs to.
 */
export function membersOf(
  repositories: readonly GroupMember["repository"][],
  owner: ReadonlyMap<string, number>,
  settings: readonly { id: string; key: string }[],
  results: Readonly<Record<string, Readonly<Record<string, TaskResult>>>>,
): GroupMember[] {
  return repositories.map((repository) => {
    const scores = Object.fromEntries(
      settings.map(({ id, key }) => {
        const mine = Object.entries(results[key] ?? {})
          .filter(([task]) => owner.get(task) === repository.id)
          .map(([, result]) => result);
        const passed = mine.filter((result) => result.pass).length;
        const priced = mine.filter((result) => result.costUsd !== undefined);
        const spend = priced.reduce((sum, result) => sum + (result.costUsd ?? 0), 0);
        const score: MemberScore = {
          passed,
          tasks: mine.length,
          accuracy: mine.length > 0 ? (passed / mine.length) * 100 : 0,
          costPerTaskUsd: priced.length > 0 ? spend / priced.length : 0,
          costedTasks: priced.length,
        };
        return [id, score];
      }),
    );
    // Every released setting covers the same tasks, so any one's list counts them.
    const first = Object.values(results)[0] ?? {};
    const tasks = Object.keys(first).filter((task) => owner.get(task) === repository.id).length;
    return { repository, tasks, scores };
  });
}

/** The released setting most accurate on one member alone; the cheaper one there breaks a tie. */
export function mostAccurate(
  group: Pick<PublishedGroup, "settings">,
  member: Pick<GroupMember, "scores">,
): { id: string; label: string; accuracy: number } | undefined {
  let best: { id: string; label: string; accuracy: number; cost: number } | undefined;
  for (const setting of group.settings) {
    const score = member.scores[setting.id];
    if (!score || score.tasks === 0) continue;
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
    ...(group.logo ? { logo: group.logo } : {}),
    updatedAt: group.updatedAt,
    repositories: group.members.map((member) => member.repository.fullName),
    tasks: group.tasks,
    settings: group.settings.length,
    picks: picks(group.settings).map((pick) => ({ ...pick, setting: cardSetting(pick.setting) })),
    frontier: frontierSettings(group.settings).map(cardSetting),
    others: offFrontier(group.settings).slice(0, PREVIEW_LINES).map(cardSetting),
  };
}
