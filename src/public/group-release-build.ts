import { type ReleaseInputs, releaseHash, scoreRelease } from "./release-build.js";
import type { PreviousRelease, ReleaseTask } from "./release-rule.js";
import { scores } from "./release-rule.js";
import {
  type GroupReleasePayload,
  RELEASE_SCHEMA_VERSION,
  type ReleasePublisher,
  type ReleaseRepository,
} from "./release-types.js";

export interface BuiltGroupRelease {
  /** The public part, before the route adds the members' card metadata and the avatar. */
  payload: GroupReleasePayload;
  hash: string;
  /** Private: stored on the row, never served. */
  detail: Record<string, unknown> & PreviousRelease & { releasedTasks: ReleaseTask[] };
}

/**
 * Builds a group's release: one repository release over every member's tasks pooled, as the
 * rule builds any release, with each member's share of it alongside. A member none of whose tasks
 * every ticked setting ran is left out of the release.
 */
export function buildGroupRelease(
  inputs: ReleaseInputs,
  chosenKeys: readonly string[],
  context: {
    group: { slug: string; name: string };
    /** The members, by GitHub repository id. */
    members: readonly Pick<ReleaseRepository, "id" | "fullName">[];
    /** Each task key's member, by GitHub repository id. */
    memberOf: ReadonlyMap<string, number>;
    publisher: ReleasePublisher;
    publishTasks?: boolean;
  },
): BuiltGroupRelease {
  const scored = scoreRelease(inputs, chosenKeys, context.publishTasks);
  const tasksOf = new Map<number, string[]>();
  for (const task of scored.tasks) {
    const member = context.memberOf.get(task);
    if (member !== undefined) tasksOf.set(member, [...(tasksOf.get(member) ?? []), task]);
  }
  const members = context.members.filter((member) => tasksOf.has(member.id));
  const payload: GroupReleasePayload = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    group: {
      slug: context.group.slug,
      name: context.group.name,
      members: members.map(({ id, fullName }) => ({ id, fullName })),
    },
    publisher: { login: context.publisher.login, kind: context.publisher.kind },
    tasks: scored.tasks.length,
    settings: scored.settings,
    frontier: scored.settings.filter((setting) => setting.onFrontier).map((setting) => setting.id),
    breakdown: members.map((member) => {
      const tasks = tasksOf.get(member.id) ?? [];
      return {
        repositoryId: member.id,
        tasks: tasks.length,
        settings: scores(scored.chosen, tasks).map(
          ({ id, passed, accuracy, costPerTaskUsd, totalCostUsd }) => ({
            id,
            passed,
            accuracy,
            costPerTaskUsd,
            totalCostUsd,
          }),
        ),
      };
    }),
    ...(context.publishTasks ? { tasksPublished: true as const } : {}),
  };
  const names = new Map(context.members.map((member) => [member.id, member.fullName]));
  const repositoryOf = (key: string) => {
    const member = context.memberOf.get(key);
    return member === undefined ? undefined : names.get(member);
  };
  // Each published task names its repository, so its pull request links to the right one.
  const releasedTasks = scored.detail.releasedTasks.map((task) => {
    const repository = repositoryOf(task.key);
    return repository ? { ...task, repository } : task;
  });
  return {
    payload,
    hash: releaseHash(payload, scored),
    detail: { ...scored.detail, releasedTasks },
  };
}
