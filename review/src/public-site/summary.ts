import type { PublicRepoPage, PublicRepoSummary } from "./contract";
import { frontierSettings, picks } from "./picks";

/** Reduces a repository page to the card the directory shows. */
export function repoSummary(page: PublicRepoPage): PublicRepoSummary {
  const { release } = page;
  return {
    repository: release.repository,
    publisher: release.publisher,
    releaseId: release.releaseId,
    releasedAt: release.releasedAt,
    tasks: release.tasks,
    settings: release.settings.length,
    picks: picks(release.settings),
    frontier: frontierSettings(release.settings).map((setting) => ({
      id: setting.id,
      model: setting.model,
      accuracy: setting.accuracy,
      costPerTaskUsd: setting.costPerTaskUsd,
    })),
    endorsed: page.endorsed,
  };
}
