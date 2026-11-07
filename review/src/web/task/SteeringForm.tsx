import React from "react";
import { MAX_FEEDBACK_LENGTH } from "../../../../src/generation/tasks/feedback-limit";
import { Block } from "../../components/Script";
import { formatAgo, type TaskItem } from "../api";
import { cn } from "../primitives/cn";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, controlStyles, fieldStyles, Notice } from "../ui";
import { getSteeringNotes, type SteeringNote, sendSteeringNote } from "./steering-api";

/**
 * Notes for a task still generating. Each waits until the author's next turn, which starts after
 * every verify and after a reviewer's suggestions; the list shows which turn read each one.
 */
export function SteeringForm({
  org,
  fullName,
  task,
}: {
  org: string;
  fullName: string;
  task: TaskItem;
}) {
  const [notes, setNotes] = React.useState<SteeringNote[]>([]);
  const [feedback, setFeedback] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const text = feedback.trim();
  const { runId, taskId } = task;

  React.useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const found = await getSteeringNotes(org, fullName, { runId, taskId });
        if (!stopped) setNotes(found);
      } catch {
        // The next poll tries again; sending still reports its own errors.
      }
      if (!stopped) timer = setTimeout(() => void load(), 5_000);
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [org, fullName, runId, taskId]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const note = await sendSteeringNote(org, fullName, { runId, taskId }, text);
      setFeedback("");
      setNotes((current) => [...current, note]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
        <label htmlFor="task-steering" className={fieldStyles}>
          <span className="flex items-center gap-1.5">
            Note to the Author{" "}
            <InfoTooltip label="The author reads your note when its next turn starts: after its next verify, or after the reviewer's suggestions." />
          </span>
          <textarea
            id="task-steering"
            aria-label="Note to the Author"
            rows={4}
            maxLength={MAX_FEEDBACK_LENGTH}
            placeholder="For example: cache the event's public data with 'use cache', and test that it's reused."
            className={cn(controlStyles, "h-auto resize-y py-2")}
            value={feedback}
            disabled={busy}
            onChange={(event) => setFeedback(event.target.value)}
          />
        </label>
        {error && <Notice>{error}</Notice>}
        <div>
          <Button type="submit" variant="primary" disabled={busy || !text}>
            {busy ? "Sending…" : "Send Note"}
          </Button>
        </div>
      </form>
      {notes.length > 0 && (
        <Block title="Notes Sent" detail={String(notes.length)}>
          <ul className="divide-y divide-border">
            {notes.map((note) => (
              <li key={note.id} className="grid gap-1.5 px-4 py-3">
                <span className="text-xs text-muted-foreground">
                  {[
                    note.author,
                    formatAgo(note.createdAt),
                    note.delivered
                      ? `Read in round ${note.delivered.round}, turn ${note.delivered.turn}`
                      : "Waiting for the next turn",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <p className="text-sm leading-6 whitespace-pre-wrap wrap-anywhere">
                  {note.feedback}
                </p>
              </li>
            ))}
          </ul>
        </Block>
      )}
    </div>
  );
}
