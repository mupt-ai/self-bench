import type { FrozenTask } from "../db/benchmarks.js";
import { runnable } from "../db/task-record.js";
import { variantRunnable } from "../db/task-variants.js";
import type { TaskStore } from "../db/tasks.js";
import { type JudgeNeeds, mergeJudgeNeeds } from "../harnesses/harbor/host-variables.js";
import { repositoryTasks } from "./frozen-tasks.js";
import type { SummaryTask } from "./model-summary.js";
import { evaluationTaskKey } from "./models.js";
import type { EvaluationScope } from "./scope.js";
import type { EvaluationInput, EvaluationRun } from "./types.js";
import { visibleTrials } from "./visible-trials.js";

type EvaluationTask = EvaluationInput["tasks"][number];
type TaskKey = { runId: string; taskId: string };

/** A task the Run page offers. Only a repository's tasks have a difficulty. */
export interface DatasetTask extends TaskKey {
  difficulty?: string;
  /** In a repository group, the member repository the task is from. */
  repository?: string;
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
   * `tasks` as an environment (task-variant-schema.ts) built them: each task's ready variant's
   * bundle, under the task's own key, so its results count as the task's. Tasks the environment
   * has no ready variant for are left out; undefined when the scope has no such environment.
   */
  environment?(
    id: number,
    tasks: readonly EvaluationTask[],
  ): Promise<{ name: string; tasks: EvaluationTask[] } | undefined>;
  /**
   * The runs as lists show them, and a tag that changes when that view does. Only a repository
   * edits its tasks, so only it hides trials of tasks deleted since.
   */
  visible?(runs: EvaluationRun[]): Promise<{ runs: EvaluationRun[]; tag: string }>;
  /**
   * Other scopes whose runs count here as well, with the name each is shown by: a repository
   * group's members, whose own runs on their tasks count toward the group's results.
   */
  readonly sources?: readonly { scope: EvaluationScope; name: string }[];
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
    async environment(id, picked) {
      const environment = await tasks.variants.findEnvironment(repoId, id);
      if (!environment) return undefined;
      const [approved, variants] = await Promise.all([
        tasks.listForRepo(repoId),
        tasks.variants.listForRepo(repoId),
      ]);
      const ready = new Map<string, (typeof variants)[number]>();
      const byId = new Map(approved.map((task) => [task.id, task]));
      for (const variant of variants) {
        const task = byId.get(variant.parentId);
        if (task && variant.environmentId === id && variantRunnable(variant))
          ready.set(evaluationTaskKey(task.runId, task.taskId), variant);
      }
      return {
        name: environment.name,
        tasks: picked.flatMap((task) => {
          const variant = ready.get(evaluationTaskKey(task.runId, task.taskId));
          if (!variant?.bundleKey) return [];
          // The task's key, so its results count as the task's; the variant's bundle and images.
          return [
            {
              runId: task.runId,
              taskId: task.taskId,
              bundleKey: variant.bundleKey,
              ...(task.resources ? { resources: task.resources } : {}),
              ...(variant.images ? { images: variant.images } : {}),
            },
          ];
        }),
      };
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

/** A member of a repository group, as its dataset reads it. */
export interface GroupMemberRepo {
  repoId: number;
  fullName: string;
}

/**
 * A repository group's tasks: every member's approved tasks, each labeled with its repository.
 * A task runs exactly as it does in its own repository, from that repository's bundle.
 */
export function groupDataset(
  tasks: TaskStore,
  members: readonly GroupMemberRepo[],
): EvaluationDataset {
  const each = members.map((member) => ({
    member,
    dataset: repositoryDataset(tasks, member.repoId),
  }));
  /** Which member each approved task belongs to, by task key. */
  const owners = async () => {
    const byKey = new Map<string, GroupMemberRepo>();
    for (const { member } of each)
      for (const task of (await tasks.listForRepo(member.repoId)).filter(runnable))
        byKey.set(evaluationTaskKey(task.runId, task.taskId), member);
    return byKey;
  };
  return {
    sources: members.map((member) => ({ scope: { repoId: member.repoId }, name: member.fullName })),
    async options() {
      const listed = await Promise.all(
        each.map(async ({ member, dataset }) =>
          (await dataset.options()).tasks.map((task) => ({ ...task, repository: member.fullName })),
        ),
      );
      return { tasks: listed.flat(), judge: mergeJudgeNeeds([]) };
    },
    async select(picked) {
      if (!picked) return (await Promise.all(each.map(({ dataset }) => dataset.select()))).flat();
      const byKey = await owners();
      const wanted = new Map<number, TaskKey[]>();
      for (const task of picked) {
        const member = byKey.get(evaluationTaskKey(task.runId, task.taskId));
        if (!member)
          throw new Error("Every task must be human-approved in this group's repositories");
        wanted.set(member.repoId, [...(wanted.get(member.repoId) ?? []), task]);
      }
      const chosen = await Promise.all(
        [...wanted].map(([repoId, keys]) => repositoryTasks(tasks, repoId, keys)),
      );
      return chosen.flat();
    },
    async summaryTasks() {
      return (await Promise.all(each.map(({ dataset }) => dataset.summaryTasks()))).flat();
    },
    async visible(runs) {
      // A trial is hidden when its task was deleted from the repository it came from.
      let kept = runs;
      const tags: string[] = [];
      for (const { member } of each) {
        const view = await visibleTrials(tasks, member.repoId, kept);
        kept = view.runs;
        tags.push(view.tag);
      }
      return { runs: kept, tag: tags.join(".") };
    },
  };
}
