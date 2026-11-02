import type { FrozenTask } from "../db/benchmarks.js";
import { runnable } from "../db/task-record.js";
import type { TaskStore } from "../db/tasks.js";
import { type JudgeNeeds, mergeJudgeNeeds } from "../harnesses/harbor/host-variables.js";
import { repositoryTasks } from "./frozen-tasks.js";
import type { SummaryTask } from "./model-summary.js";
import { evaluationTaskKey } from "./models.js";
import type { EvaluationInput, EvaluationRun } from "./types.js";
import { visibleTrials } from "./visible-trials.js";

type EvaluationTask = EvaluationInput["tasks"][number];
type TaskKey = { runId: string; taskId: string };

/** A task the Run page offers. Only a repository's tasks have a difficulty. */
export interface DatasetTask extends TaskKey {
  difficulty?: string;
}

/**
 * What a scope's evaluations run on: a repository's approved tasks, or the tasks a benchmark froze
 * from Harbor's registry when it was added. It is the only way the two scopes differ; everything
 * built on it (the Run page's task list, comparisons, retries, summaries) is the same for both.
 */
export interface EvaluationDataset {
  /** The tasks a comparison may pick from, and what their LLM judge reads. */
  options(): Promise<{ tasks: DatasetTask[]; judge: JudgeNeeds }>;
  /** The picked tasks as evaluations run them; every task when none are named. */
  select(picked?: readonly TaskKey[]): Promise<EvaluationTask[]>;
  /** The tasks results count on. */
  summaryTasks(): Promise<SummaryTask[]>;
  /**
   * The runs as lists show them, and a tag that changes when that view does. Only a repository
   * edits its tasks, so only it hides trials of tasks deleted since.
   */
  visible?(runs: EvaluationRun[]): Promise<{ runs: EvaluationRun[]; tag: string }>;
}

/** A repository's approved tasks. */
export function repositoryDataset(tasks: TaskStore, repoId: number): EvaluationDataset {
  const approved = async () => (await tasks.listForRepo(repoId)).filter(runnable);
  return {
    async options() {
      const listed = (await approved()).map(({ runId, taskId, difficulty }) => ({
        runId,
        taskId,
        difficulty,
      }));
      return { tasks: listed, judge: mergeJudgeNeeds([]) };
    },
    async select(picked) {
      return repositoryTasks(tasks, repoId, picked ?? (await approved()));
    },
    async summaryTasks() {
      return (await approved()).flatMap(({ runId, taskId, bundleKey, difficulty }) =>
        bundleKey ? [{ runId, taskId, bundleKey, difficulty }] : [],
      );
    },
    visible: (runs) => visibleTrials(tasks, repoId, runs),
  };
}

/**
 * A benchmark's tasks, as frozen when it was added, so every comparison matches its Dataset tab,
 * task files, and judge requirements however the registry changes.
 */
export function benchmarkDataset(frozen: () => Promise<FrozenTask[]>): EvaluationDataset {
  return {
    async options() {
      const tasks = await frozen();
      return {
        tasks: tasks.map(({ runId, taskId }) => ({ runId, taskId })),
        judge: mergeJudgeNeeds(tasks.map((task) => task.judge)),
      };
    },
    async select(picked) {
      const tasks = await frozen();
      if (!picked) return tasks;
      const wanted = new Set(picked.map((task) => evaluationTaskKey(task.runId, task.taskId)));
      if (wanted.size !== picked.length) throw new Error("Duplicate task selection");
      const chosen = tasks.filter((task) => wanted.has(evaluationTaskKey(task.runId, task.taskId)));
      if (chosen.length !== wanted.size) throw new Error("Every task must be in this benchmark");
      return chosen;
    },
    async summaryTasks() {
      return (await frozen()).map(({ runId, taskId, bundleKey }) => ({ runId, taskId, bundleKey }));
    },
  };
}
