import { ChevronDown, Database } from "lucide-react";
import { Link } from "react-router";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { evaluationTaskKey } from "../../../../src/evaluation/task-identity";
import { Button } from "../ui";
import type { EvaluationOptions } from "./api";

export function RunTaskPicker({
  repo,
  availableTasks,
  draft,
  onChange,
  onSkipCompleted,
  onRunMissing,
  tasksReady,
  canRun,
  disabled,
}: {
  repo: string;
  availableTasks: EvaluationOptions["tasks"];
  draft: ComparisonDraft;
  onChange: (tasks: ComparisonDraft["tasks"]) => void;
  onSkipCompleted: (checked: boolean) => void;
  onRunMissing: () => void;
  tasksReady: boolean;
  canRun: boolean;
  disabled: boolean;
}) {
  const selected = new Set(draft.tasks.map((task) => evaluationTaskKey(task.runId, task.taskId)));
  return (
    <details className="group panel mb-5">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 marker:hidden [&::-webkit-details-marker]:hidden">
        <Database className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">
            {draft.tasks.length} {draft.tasks.length === 1 ? "Accepted Task" : "Accepted Tasks"}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {availableTasks.length
              ? "Choose which tasks every configuration runs against."
              : tasksReady
                ? "No approved tasks are available."
                : "Loading approved tasks…"}
          </span>
        </span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {draft.tasks.length} of {availableTasks.length} Selected
        </span>
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t border-border">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex gap-2">
            <Button
              type="button"
              size="small"
              disabled={disabled}
              onClick={() =>
                onChange(availableTasks.map(({ runId, taskId }) => ({ runId, taskId })))
              }
            >
              Select All
            </Button>
            <Button type="button" size="small" disabled={disabled} onClick={() => onChange([])}>
              Clear All
            </Button>
          </div>
          <Link
            className="text-sm font-medium text-muted-foreground hover:text-foreground"
            to={`/repos/${repo}`}
          >
            Review Dataset →
          </Link>
        </div>
        {availableTasks.length ? (
          <div className="max-h-72 overflow-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="w-12 px-4 py-2.5 font-semibold">
                    Include
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">
                    Task
                  </th>
                  <th scope="col" className="hidden px-4 py-2.5 font-semibold sm:table-cell">
                    Difficulty
                  </th>
                  <th scope="col" className="hidden px-4 py-2.5 font-semibold lg:table-cell">
                    Source Run
                  </th>
                </tr>
              </thead>
              <tbody>
                {availableTasks.map((task) => {
                  const key = evaluationTaskKey(task.runId, task.taskId);
                  const checked = selected.has(key);
                  return (
                    <tr key={key} className="border-t border-border hover:bg-muted/60">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${task.taskId}`}
                          checked={checked}
                          disabled={disabled}
                          onChange={() =>
                            onChange(
                              checked
                                ? draft.tasks.filter(
                                    (candidate) =>
                                      evaluationTaskKey(candidate.runId, candidate.taskId) !== key,
                                  )
                                : [...draft.tasks, { runId: task.runId, taskId: task.taskId }],
                            )
                          }
                          className="size-4 accent-brand"
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs wrap-anywhere">{task.taskId}</td>
                      <td className="hidden px-4 py-3 text-xs text-muted-foreground sm:table-cell">
                        {task.difficulty[0]?.toUpperCase()}
                        {task.difficulty.slice(1)}
                      </td>
                      <td className="hidden px-4 py-3 font-mono text-xs text-muted-foreground lg:table-cell">
                        {task.runId}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {tasksReady ? "No approved tasks available." : "Loading approved tasks…"}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 accent-brand"
              checked={draft.skipCompleted ?? false}
              disabled={disabled}
              onChange={(event) => onSkipCompleted(event.target.checked)}
            />
            Skip Completed Results
          </label>
          <Button type="button" size="small" disabled={disabled || !canRun} onClick={onRunMissing}>
            Run Missing Tasks
          </Button>
        </div>
      </div>
    </details>
  );
}
