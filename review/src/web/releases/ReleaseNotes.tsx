import { CircleAlert } from "lucide-react";
import React from "react";
import { Link } from "react-router";
import { UNSOLVED_MINIMUM } from "../../../../src/public/release-rule";
import { plural } from "../api";
import { taskPath } from "../task/review-queue";
import type { ReleaseView } from "./api";
import type { Selection } from "./selection";

/** What changes against the current release, as short notes above the summary line. */
export function Notes({ view, selection }: { view: ReleaseView; selection: Selection }) {
  // Added and left-out tasks only mean something against a current release.
  const since = view.current !== null;
  const lines = [
    since &&
      selection.added.new > 0 &&
      `${plural(selection.added.new, "new task")} since the last release`,
    since && selection.added.returning > 0 && plural(selection.added.returning, "returning task"),
    since &&
      selection.droppedFromCurrent > 0 &&
      `${plural(selection.droppedFromCurrent, "task")} of the current release left out`,
    view.preview.unrun > 0 && `${plural(view.preview.unrun, "approved task")} no setting has run`,
  ].filter((line): line is string => !!line);
  if (lines.length === 0) return null;
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/**
 * Chosen tasks no setting passed, though enough ran them: their hidden tests may fail correct
 * solutions. Only a warning; the releaser decides what to do with them.
 */
export function Unsolved({
  view,
  selection,
  repo,
}: {
  view: ReleaseView;
  selection: Selection;
  repo: string;
}) {
  const tasks = selection.unsolved.flatMap((index) => view.preview.tasks[index] ?? []);
  if (tasks.length === 0) return null;
  const shown = tasks.slice(0, 10);
  const remaining = tasks.length - shown.length;
  return (
    <div className="flex items-start gap-2 text-sm text-foreground">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      <p className="min-w-0">
        No setting passed {plural(tasks.length, "task")}, though {UNSOLVED_MINIMUM} or more ran
        each. Check their hidden tests before releasing:{" "}
        {shown.map((task, position) => (
          <React.Fragment key={task.key}>
            {position > 0 && ", "}
            <Link
              to={taskPath(repo, task)}
              // A new tab, so the dialog keeps its ticks while the tests are checked.
              target="_blank"
              rel="noreferrer"
              className="font-mono text-xs underline decoration-foreground/25 underline-offset-4 hover:decoration-foreground"
              title={`None of the ${task.unsolved} settings with an eligible result on this task passed`}
            >
              {task.taskId}
            </Link>
          </React.Fragment>
        ))}
        {remaining > 0 && `, and ${remaining} more`}.
      </p>
    </div>
  );
}
