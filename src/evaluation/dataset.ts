import type { FrozenTask } from "../db/benchmarks.js";
import { runnable } from "../db/task-record.js";
import { type TaskVariantRecord, variantRunnable } from "../db/task-variants.js";
import type { TaskRecord, TaskStore } from "../db/tasks.js";
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
  /**
   * A variant of a task (generation/tasks/variant.ts): its label and the task it changes. Only a
   * comparison that picks it runs it, and its results are reported beside that task's.
   */
  variant?: { label: string; of: TaskKey };
}

/** A variant results report beside its task: what it is, and the bundle its trials ran. */
interface VariantSummaryTask extends SummaryTask {
  label: string;
  of: TaskKey;
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
  /** The variants of those tasks, which are reported beside them and never counted with them. */
  variantTasks?(): Promise<VariantSummaryTask[]>;
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

/** An approved task's accepted variants, each with the task it changes. */
async function runnableVariants(
  tasks: TaskStore,
  repoId: number,
  approved: readonly TaskRecord[],
): Promise<{ variant: TaskVariantRecord; task: TaskRecord }[]> {
  const byId = new Map(approved.map((task) => [task.id, task]));
  return (await tasks.variants.listForRepo(repoId)).flatMap((variant) => {
    const task = byId.get(variant.parentId);
    return task && variantRunnable(variant) ? [{ variant, task }] : [];
  });
}

/** A repository's approved tasks, and their variants for comparisons that pick them. */
export function repositoryDataset(tasks: TaskStore, repoId: number): EvaluationDataset {
  const approved = async () => (await tasks.listForRepo(repoId)).filter(runnable);
  return {
    async options() {
      const found = await approved();
      const listed: DatasetTask[] = found.map(({ runId, taskId, difficulty }) => ({
        runId,
        taskId,
        difficulty,
      }));
      for (const { variant, task } of await runnableVariants(tasks, repoId, found))
        listed.push({
          runId: variant.runId,
          taskId: variant.taskId,
          difficulty: task.difficulty,
          variant: { label: variant.label, of: { runId: task.runId, taskId: task.taskId } },
        });
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
    async variantTasks() {
      return (await runnableVariants(tasks, repoId, await approved())).map(({ variant, task }) => ({
        runId: variant.runId,
        taskId: variant.taskId,
        bundleKey: variant.bundleKey as string,
        difficulty: task.difficulty,
        label: variant.label,
        of: { runId: task.runId, taskId: task.taskId },
      }));
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
    for (const { member, dataset } of each)
      for (const task of (await dataset.options()).tasks)
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
    async variantTasks() {
      return (await Promise.all(each.map(({ dataset }) => dataset.variantTasks?.() ?? []))).flat();
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
