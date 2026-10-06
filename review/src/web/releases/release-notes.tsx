import { plural } from "../api";
import type { ReleaseView } from "./api";
import type { selectionOf } from "./selection";

/** What becomes public and what stays private, shown on the info icon beside the summary. */
export function privacyNote(
  workspace: { login: string; kind: "org" | "user" },
  tasks: boolean,
  subject: "repository" | "group",
): string {
  const publisher =
    workspace.kind === "user"
      ? `you as publisher, under your GitHub username ${workspace.login}`
      : `the ${workspace.login} workspace as publisher`;
  const what = subject === "group" ? "the group's name and repositories" : "the repository";
  return tasks
    ? `Public: ${what}, ${publisher}, each setting's model, harness, accuracy, and cost, and each task with its pull request, instruction, tests, and solution. Private: per-task results, transcripts, endpoint hosts, and who pressed Release.`
    : `Public: ${what}, ${publisher}, and each setting's model, harness, accuracy, and cost. Private: which tasks and pull requests were used, per-task results, transcripts, endpoint hosts, and who pressed Release.`;
}

/** What changes against the current release, as short notes above the summary line. */
export function Notes({
  view,
  selection,
}: {
  view: ReleaseView;
  selection: ReturnType<typeof selectionOf>;
}) {
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
