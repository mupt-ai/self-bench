import type { PublicGroupRelease, PublicRepoPage } from "../../contract";

/**
 * A group of two repositories with a long name, released as one benchmark: its page, its home
 * card, and a breakdown table with a long repository name in it.
 */
export function syntheticGroups(pages: readonly PublicRepoPage[]): PublicGroupRelease[] {
  const [first, second] = pages;
  if (!first || !second) return [];
  const { releaseId: _, repository: __, ...release } = first.release;
  const members = [first.release.repository, second.release.repository];
  return [
    {
      ...release,
      releaseId: "synthetic-group",
      group: { slug: "synthetic-group", name: "Full-Stack Apps With a Long Group Name", members },
      breakdown: members.map((member, index) => ({
        repositoryId: member.id,
        tasks: index === 0 ? 30 : 10,
        settings: release.settings.map(({ id, accuracy, costPerTaskUsd }) => ({
          id,
          passed: 0,
          accuracy: index === 0 ? accuracy : 100 - accuracy,
          costPerTaskUsd,
          totalCostUsd: costPerTaskUsd * 10,
        })),
      })),
    },
  ];
}
