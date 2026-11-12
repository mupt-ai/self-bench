import React from "react";
import { Link } from "react-router";
import { taskPath } from "../task/review-queue";
import { StateStamp } from "../task/state";
import { Button, Notice } from "../ui";
import { useGenerationSettings } from "../useGenerationSettings";
import {
  buildEnvironment,
  deleteEnvironment,
  type EnvironmentItem,
  type EnvironmentTaskItem,
  getEnvironment,
} from "./environment-api";

/** The tasks a build could not start, each with why; null when every one started. */
export const notStarted = (failures?: string[]) =>
  failures?.length
    ? `${failures.length} ${failures.length === 1 ? "task" : "tasks"} did not start: ${failures.join("; ")}`
    : null;

/** One environment's script and each task's check, and building the tasks it lacks or deleting it. */
export function EnvironmentDetail({
  org,
  fullName,
  environment,
  onChanged,
}: {
  org: string;
  fullName: string;
  environment: EnvironmentItem;
  onChanged: () => void;
}) {
  const [tasks, setTasks] = React.useState<EnvironmentTaskItem[]>();
  const [busy, setBusy] = React.useState<"build" | "delete" | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const { id, tasks: counts } = environment;
  const { settings, valid } = useGenerationSettings(org, fullName);

  // biome-ignore lint/correctness/useExhaustiveDependencies: counts change as checks settle.
  React.useEffect(() => {
    let stopped = false;
    getEnvironment(org, fullName, id).then(
      (found) => {
        if (!stopped) setTasks(found.tasks);
      },
      (cause) => {
        if (!stopped) setNotice(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      stopped = true;
    };
  }, [org, fullName, id, counts.ready, counts.checking, counts.failed]);

  const act = async (action: "build" | "delete") => {
    setBusy(action);
    setNotice(null);
    try {
      // Builds with the generation settings last chosen for this repository, as New Environment did.
      if (action === "build") {
        const { failures } = await buildEnvironment(
          org,
          fullName,
          id,
          valid ? settings : undefined,
        );
        setNotice(notStarted(failures));
      } else await deleteEnvironment(org, fullName, id);
      onChanged();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  const unfinished = (tasks ?? []).filter((task) => task.state !== "accepted");
  return (
    <div className="grid gap-4 py-2">
      {environment.script !== undefined && (
        <pre className="max-h-64 overflow-auto panel p-3 font-mono text-sm leading-6 whitespace-pre-wrap wrap-anywhere">
          {environment.script}
        </pre>
      )}
      {!tasks ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading tasks…
        </p>
      ) : unfinished.length === 0 ? (
        <p className="text-sm text-muted-foreground">Every built task is ready to run.</p>
      ) : (
        <ul className="grid gap-3">
          {unfinished.map((task) => (
            <li key={task.runId} className="grid gap-1">
              <span className="flex flex-wrap items-center gap-3">
                <Link
                  className="font-mono text-sm hover:underline"
                  to={taskPath(fullName, task.task)}
                  onClick={(event) => event.stopPropagation()}
                >
                  {task.task.taskId}
                </Link>
                <StateStamp state={task.state} />
              </span>
              {task.reasonSummary && (
                <span className="text-sm text-muted-foreground wrap-anywhere">
                  {task.reasonSummary}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice && <Notice>{notice}</Notice>}
      <div className="flex flex-wrap gap-2">
        {environment.script !== undefined && (
          <Button disabled={busy !== null} onClick={() => void act("build")}>
            {busy === "build" ? "Starting…" : "Build Missing Tasks"}
          </Button>
        )}
        <Button variant="ghost" disabled={busy !== null} onClick={() => void act("delete")}>
          {busy === "delete" ? "Deleting…" : "Delete Environment"}
        </Button>
      </div>
    </div>
  );
}
