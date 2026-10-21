import type { ArtifactStore } from "../../artifacts/index.js";
import { type AuthoredTaskDraft, authoredTaskDraftSchema } from "../../contracts/index.js";
import { authoringRoundResultKey } from "../pipeline/authoring.js";

/**
 * The draft a finished candidate last submitted: its latest round that ended in a submission.
 * An accepted task's is the one the reviewer accepted; a rejected task's may have none.
 */
export async function submittedDraft(
  store: ArtifactStore,
  runId: string,
  candidateId: string,
): Promise<AuthoredTaskDraft | undefined> {
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
  return stagedDraft(store, runId, candidateId);
}

/** A failed revision may not have submitted yet; its starting draft is staged separately. */
async function stagedDraft(
  store: ArtifactStore,
  runId: string,
  candidateId: string,
): Promise<AuthoredTaskDraft | undefined> {
  const prefix = `runs/${runId}/authoring/${candidateId}/revision`;
  const definitionKey = `${prefix}/definition.json`;
  const sourceKey = `${prefix}/source-task.tar.gz`;
  const [definition, sourceBundle] = await Promise.all([
    store.stat(definitionKey),
    store.stat(sourceKey),
  ]);
  if (!definition || !sourceBundle) return undefined;
  try {
    const bytes = await store.getByKey(definitionKey);
    if (!bytes) return undefined;
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as { taskId?: unknown };
    if (typeof parsed.taskId !== "string" || !parsed.taskId) return undefined;
    return {
      candidateId,
      taskId: parsed.taskId,
      definition: { ...definition, contentType: "application/json" },
      sourceBundle: { ...sourceBundle, contentType: "application/gzip" },
    };
  } catch {
    return undefined;
  }
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
  const prefix = `runs/${runId}/authoring/${draft.candidateId}/revision`;
  const [definition, sourceBundle] = await Promise.all(
    [
      { from: draft.definition, name: "definition.json" },
      { from: draft.sourceBundle, name: "source-task.tar.gz" },
    ].map(async ({ from, name }) =>
      store.put(`${prefix}/${name}`, await store.get(from), from.contentType),
    ),
  );
  if (!definition || !sourceBundle) throw new Error("revision draft was not staged");
  return { ...draft, definition, sourceBundle };
}
