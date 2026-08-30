import { assertPullRequestBelongsToRepository } from "../github.js";
import type { ProvenanceMessage } from "./types.js";

export function combineRunProvenance(
  repositoryUrl: string,
  local: readonly ProvenanceMessage[],
  github: readonly ProvenanceMessage[],
): ProvenanceMessage[] {
  const explicitlyAssociatedPrs = new Set<number>();
  for (const message of local) {
    if (message.sourcePr === undefined || message.sourceUrl === undefined) {
      continue;
    }
    assertPullRequestBelongsToRepository(repositoryUrl, message.sourceUrl, message.sourcePr);
    explicitlyAssociatedPrs.add(message.sourcePr);
  }
  return [
    ...local,
    ...github.filter(
      (message) =>
        message.sourceType !== "github-pull-request" ||
        !explicitlyAssociatedPrs.has(message.sourcePr),
    ),
  ];
}

export function assertProvenanceMatchesPullRequest(
  message: ProvenanceMessage,
  sourcePr: number,
  sourceUrl: string,
  provenance: readonly ProvenanceMessage[] = [message],
): void {
  if (
    (message.sourcePr !== undefined || message.sourceUrl !== undefined) &&
    (message.sourcePr !== sourcePr || message.sourceUrl !== sourceUrl)
  ) {
    throw new Error(
      `pull request ${sourceUrl}#${sourcePr} does not match provenance ${message.sourceUrl}#${message.sourcePr}`,
    );
  }
  const hasExplicitLocalAssociation = provenance.some(
    (item) => item.sourceType !== "github-pull-request" && item.sourcePr === sourcePr,
  );
  if (
    hasExplicitLocalAssociation &&
    message.sourceType !== "github-pull-request" &&
    (message.sourcePr !== sourcePr || message.sourceUrl !== sourceUrl)
  ) {
    throw new Error(
      `pull request ${sourceUrl}#${sourcePr} has explicit local provenance; unbound local provenance cannot be selected`,
    );
  }
}
