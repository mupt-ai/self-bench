import { dirname } from "node:path";
import type { ArtifactStore } from "../../artifacts/index.js";
import {
  type ArtifactRef,
  type AuthoredTaskDraft,
  authoredTaskDraftSchema,
} from "../../contracts/index.js";
import { authoringRoundResultKey } from "../pipeline/authoring.js";
import { compiledBundleKey } from "./task-images.js";

/**
 * The draft a finished task last submitted: the one beside the compiled bundle it runs, when a
 * conversion wrote it there (task-conversion.ts), else its latest round that ended in a
 * submission. An accepted task's is the one the reviewer accepted; a rejected task's may have none.
 */
export async function submittedDraft(
  store: ArtifactStore,
  task: { runId: string; candidateId: string; taskId: string; bundleKey?: string },
): Promise<AuthoredTaskDraft | undefined> {
  const { runId, candidateId, taskId } = task;
  const draft = (ref: Omit<ArtifactRef, "contentType">) => ({
    candidateId,
    taskId,
    sourceBundle: { ...ref, contentType: "application/gzip" },
  });
  const converted =
    task.bundleKey &&
    (await store.stat(`${dirname(compiledBundleKey(task.bundleKey))}/${SOURCE_BUNDLE}`));
  if (converted) return draft(converted);
  const rounds = (await store.folders(`runs/${runId}/authoring/${candidateId}`))
    .map((folder) => /^round-(\d+)$/.exec(folder)?.[1])
    .filter((round) => round !== undefined)
    .map(Number)
    .sort((left, right) => right - left);
  for (const round of rounds) {
    const bytes = await store.getByKey(authoringRoundResultKey(runId, candidateId, round));
    if (!bytes) continue;
    const result = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
      kind?: unknown;
      task?: unknown;
    };
    if (result.kind !== "submitted") continue;
    const parsed = authoredTaskDraftSchema.safeParse(result.task);
    if (parsed.success) return parsed.data;
  }
  // A failed revision may not have submitted yet; its starting draft is staged separately.
  const staged = await store.stat(`${revisionPrefix(runId, candidateId)}/${SOURCE_BUNDLE}`);
  return staged ? draft(staged) : undefined;
}

/**
 * Copies the draft a revision starts from into the revision's own run, so the revision never
 * depends on the original's artifacts, and its files show on the task page before any check.
 */
export async function stageRevisionDraft(
  store: ArtifactStore,
  runId: string,
  draft: AuthoredTaskDraft,
): Promise<AuthoredTaskDraft> {
  const sourceBundle = await store.put(
    `${revisionPrefix(runId, draft.candidateId)}/${SOURCE_BUNDLE}`,
    await store.get(draft.sourceBundle),
    draft.sourceBundle.contentType,
  );
  return { ...draft, sourceBundle };
}

/** A submission's files as one tarball, as authors hand them off. */
export const SOURCE_BUNDLE = "source-task.tar.gz";

function revisionPrefix(runId: string, candidateId: string): string {
  return `runs/${runId}/authoring/${candidateId}/revision`;
}
