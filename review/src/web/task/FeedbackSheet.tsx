import React from "react";
import { Link } from "react-router";
import { MAX_FEEDBACK_LENGTH } from "../../../../src/generation/tasks/feedback-limit";
import { Block } from "../../components/Script";
import { sheetBody, viewerLink } from "../../components/viewer-ui";
import { formatAgo, sendTaskFeedback, type TaskItem } from "../api";
import { GenerationFields } from "../GenerationFields";
import { cn } from "../primitives/cn";
import { Button, controlStyles, fieldStyles, Notice } from "../ui";
import { useGenerationSettings } from "../useGenerationSettings";
import { taskPath } from "./review-queue";
import { StateStamp } from "./state";

/**
 * Feedback on a finished task starts an agent that revises it. The revision is a new task of the
 * same PR, so this task and the evaluations that ran it stay as they are.
 */
export function FeedbackSheet({
  org,
  fullName,
  task,
  revisions,
  onSent,
}: {
  org: string;
  fullName: string;
  task: TaskItem;
  revisions: TaskItem[];
  onSent: (revision: TaskItem) => void;
}) {
  const finished = task.state !== "in_progress";
  const {
    settings,
    setSettings,
    options,
    error: optionsError,
    valid,
    reload,
  } = useGenerationSettings(org, fullName, finished);
  const [feedback, setFeedback] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState<TaskItem | null>(null);
  const text = feedback.trim();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!text || busy || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const revision = await sendTaskFeedback(org, fullName, task, text, settings);
      setFeedback("");
      setSent(revision);
      onSent(revision);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={sheetBody}>
      {task.revisedFrom && (
        <Block
          title="Revised From"
          detail={
            <Link className={viewerLink} to={taskPath(fullName, task.revisedFrom)}>
              {task.revisedFrom.taskId}
            </Link>
          }
          pad
        >
          <p className="text-sm leading-6 whitespace-pre-wrap wrap-anywhere">{task.feedback}</p>
        </Block>
      )}
      <div>
        {finished ? (
          <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
            <label htmlFor="task-feedback" className={fieldStyles}>
              Feedback
              <textarea
                id="task-feedback"
                rows={6}
                maxLength={MAX_FEEDBACK_LENGTH}
                placeholder="For example: the hidden tests pin the exact error message, which the instruction never asks for."
                className={cn(controlStyles, "h-auto resize-y py-2")}
                value={feedback}
                disabled={busy}
                onChange={(event) => setFeedback(event.target.value)}
              />
            </label>
            {optionsError ? (
              <Notice>
                {optionsError} <Button onClick={reload}>Try Again</Button>
              </Notice>
            ) : !options ? (
              <p role="status" className="text-sm text-muted-foreground">
                Loading generation settings…
              </p>
            ) : (
              <GenerationFields
                value={settings}
                onChange={setSettings}
                options={options}
                disabled={busy}
              />
            )}
            {error && <Notice>{error}</Notice>}
            {sent && !error && (
              <Notice tone="success">
                <span>Revision started.</span>
                <Link className={viewerLink} to={taskPath(fullName, sent)}>
                  Open Revision
                </Link>
              </Notice>
            )}
            <div>
              <Button type="submit" variant="primary" disabled={busy || !text || !valid}>
                {busy ? "Starting…" : "Revise Task"}
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-sm leading-6 text-muted-foreground">
            Feedback opens once this task's generation finishes.
          </p>
        )}
      </div>
      {revisions.length > 0 && (
        <Block title="Revisions" detail={String(revisions.length)}>
          <ul className="divide-y divide-border">
            {revisions.map((revision) => (
              <li key={`${revision.runId}/${revision.taskId}`} className="grid gap-1.5 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link className={cn(viewerLink, "font-mono")} to={taskPath(fullName, revision)}>
                    {revision.runId}
                  </Link>
                  <StateStamp state={revision.state} />
                  <span className="text-xs text-muted-foreground">
                    {[revision.startedBy, formatAgo(revision.startedAt)]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                {revision.feedback && (
                  <p className="line-clamp-3 text-sm leading-6 whitespace-pre-wrap wrap-anywhere text-muted-foreground">
                    {revision.feedback}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Block>
      )}
    </div>
  );
}
