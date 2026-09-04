import type { ArtifactEntry } from "./types.js";

/** Groups the pipeline keys by candidate ID; every other group is keyed by task ID. */
const CANDIDATE_KEYED_GROUPS = new Set(["authoring", "verification", "verify"]);

/**
 * The candidate's newest definition. Legacy runs wrote one at `authoring/<id>/definition.json`;
 * the agent pipeline rewrites it per round, attempt, and verify pass, so the latest write wins.
 */
export function latestDefinitionKey(
  entries: readonly ArtifactEntry[],
  prefix: string,
  candidateId: string,
): string | undefined {
  const head = `${prefix}authoring/${candidateId}/`;
  let latest: ArtifactEntry | undefined;
  for (const entry of entries) {
    if (!entry.key.startsWith(head) || !entry.key.endsWith("/definition.json")) continue;
    if (
      !latest ||
      (entry.updatedAt ?? "") > (latest.updatedAt ?? "") ||
      ((entry.updatedAt ?? "") === (latest.updatedAt ?? "") && entry.key > latest.key)
    ) {
      latest = entry;
    }
  }
  return latest?.key;
}

/** The newest compiled bundle under the candidate, verification passes before authoring ones. */
export function latestBundleKey(
  entries: readonly ArtifactEntry[],
  prefix: string,
  candidateId: string,
): string | undefined {
  let latest: ArtifactEntry | undefined;
  for (const entry of entries) {
    const relative = entry.key.slice(prefix.length);
    const [group, owner] = relative.split("/");
    if (!CANDIDATE_KEYED_GROUPS.has(group ?? "") || owner !== candidateId) continue;
    if (!entry.key.endsWith("/harbor-task.tar.gz")) continue;
    if (!latest || (entry.updatedAt ?? "") > (latest.updatedAt ?? "")) latest = entry;
  }
  return latest?.key;
}
