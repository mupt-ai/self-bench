import { createHash } from "node:crypto";
import type { ArtifactStore } from "../artifacts.js";
import type { EvaluationInput, EvaluationRun } from "./types.js";

export function evaluationPrefix(repoId: number, id = ""): string {
  if (!Number.isSafeInteger(repoId) || repoId < 1 || (id && !/^[a-f0-9-]{36}$/.test(id)))
    throw new Error("Invalid evaluation identity");
  return `evaluations/repos/${repoId}/${id ? `${id}/` : ""}`;
}
export function initialEvaluation(input: EvaluationInput, modelLabel: string): EvaluationRun {
  const { tasks, ...metadata } = input;
  return {
    ...metadata,
    revision: 0,
    datasetKey: createHash("sha256")
      .update(
        JSON.stringify(
          tasks
            .map(({ runId, taskId, bundleKey }) => [runId, taskId, bundleKey])
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
        ),
      )
      .digest("hex"),
    modelLabel,
    status: "queued",
    trials: tasks.flatMap((task) =>
      input.harnesses.map((harness) => ({
        taskId: task.taskId,
        runId: task.runId,
        harness,
        status: "queued",
        rewards: {},
        log: "",
        steps: [],
        artifacts: [],
      })),
    ),
  };
}
export async function saveEvaluation(store: ArtifactStore, run: EvaluationRun): Promise<void> {
  run.revision += 1;
  await store.put(
    `${evaluationPrefix(run.repoId, run.id)}snapshots/${String(run.revision).padStart(10, "0")}.json`,
    Buffer.from(JSON.stringify(run)),
    "application/json",
  );
}
export async function getEvaluation(
  store: ArtifactStore,
  repoId: number,
  id: string,
): Promise<EvaluationRun | undefined> {
  const entries = await store.list(`${evaluationPrefix(repoId, id)}snapshots`);
  const latest = entries.sort((left, right) => right.key.localeCompare(left.key))[0];
  const bytes = latest ? await store.getByKey(latest.key) : undefined;
  return bytes ? (JSON.parse(Buffer.from(bytes).toString("utf8")) as EvaluationRun) : undefined;
}
export async function listEvaluations(
  store: ArtifactStore,
  repoId: number,
): Promise<EvaluationRun[]> {
  const prefix = evaluationPrefix(repoId);
  const entries = (await store.list(prefix.slice(0, -1))).filter((entry) =>
    entry.key.startsWith(prefix),
  );
  const latest = new Map<string, string>();
  for (const entry of entries) {
    if (!/\/snapshots\/\d{10}\.json$/.test(entry.key)) continue;
    const id = entry.key.slice(prefix.length).split("/")[0];
    if (id && entry.key > (latest.get(id) ?? "")) latest.set(id, entry.key);
  }
  const runs = await Promise.all(
    [...latest.values()].map(async (key) => {
      const bytes = await store.getByKey(key);
      return bytes ? (JSON.parse(Buffer.from(bytes).toString("utf8")) as EvaluationRun) : undefined;
    }),
  );
  return runs
    .filter((run): run is EvaluationRun => !!run)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
