import type { RepoTaskCounts, TaskRecord, TaskStore, TaskUpsert } from "./task-store.js";

/** In-memory TaskStore with the Postgres contract, for route tests. */
export function createMemoryTaskStore(logins: Map<number, string>): TaskStore {
  const tasks = new Map<string, TaskRecord>();
  let nextId = 1;
  const key = (runId: string, candidateId: string) => `${runId}:${candidateId}`;
  const byId = (id: number): TaskRecord => {
    const found = [...tasks.values()].find((task) => task.id === id);
    if (!found) throw new Error(`task ${id} vanished`);
    return found;
  };
  const put = (task: TaskRecord) => tasks.set(key(task.runId, task.candidateId), task);
  return {
    async upsertMany(rows: readonly TaskUpsert[]) {
      for (const row of rows) {
        const existing = tasks.get(key(row.runId, row.candidateId));
        put({
          ...row,
          id: existing?.id ?? nextId++,
          ...(existing?.review ? { review: existing.review } : {}),
          syncedAt: new Date().toISOString(),
        });
      }
    },
    async listForRepo(repoId) {
      return [...tasks.values()]
        .filter((task) => task.repoId === repoId)
        .sort(
          (left, right) =>
            left.runId.localeCompare(right.runId) || left.taskId.localeCompare(right.taskId),
        );
    },
    async find(repoId, runId, taskOrCandidateId) {
      const inRun = [...tasks.values()].filter(
        (task) => task.repoId === repoId && task.runId === runId,
      );
      return (
        inRun.find((task) => task.taskId === taskOrCandidateId) ??
        inRun.find((task) => task.candidateId === taskOrCandidateId)
      );
    },
    async deleteForRun(repoId, runId) {
      let removed = 0;
      for (const [id, task] of tasks) {
        if (task.repoId === repoId && task.runId === runId) {
          tasks.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
    async review(taskRowId, verdict) {
      const task = byId(taskRowId);
      const updated: TaskRecord = {
        ...task,
        review: {
          decision: verdict.decision,
          note: verdict.note,
          decidedBy: logins.get(verdict.userId) ?? "",
          decidedAt: new Date().toISOString(),
        },
      };
      put(updated);
      return updated;
    },
    async clearReview(taskRowId) {
      const { review: _dropped, ...rest } = byId(taskRowId);
      put(rest);
      return rest;
    },
    async countsForRepos(repoIds) {
      const counts = new Map<number, RepoTaskCounts>();
      for (const task of tasks.values()) {
        if (!repoIds.includes(task.repoId)) continue;
        const current = counts.get(task.repoId) ?? {
          repoId: task.repoId,
          total: 0,
          accepted: 0,
          needsReview: 0,
          rejected: 0,
        };
        const decision = task.review?.decision;
        const rejected =
          decision === "reject" ||
          (!decision &&
            (task.pipelineStatus === "rejected" ||
              task.pipelineStatus === "infrastructure_failed"));
        counts.set(task.repoId, {
          ...current,
          total: current.total + 1,
          accepted: current.accepted + (decision === "approve" ? 1 : 0),
          needsReview:
            current.needsReview + (!decision && task.pipelineStatus === "accepted" ? 1 : 0),
          rejected: current.rejected + (rejected ? 1 : 0),
          ...(task.sourcePr !== undefined &&
          (current.lastPr === undefined || task.sourcePr > current.lastPr)
            ? { lastPr: task.sourcePr }
            : current.lastPr !== undefined
              ? { lastPr: current.lastPr }
              : {}),
        });
      }
      return [...counts.values()];
    },
  };
}
