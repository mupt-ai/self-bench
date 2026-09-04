import React from "react";
import { addPullRequest, type TaskItem } from "./api";
import type { SiteOrg } from "./session";

export interface AddPrSheetProps {
  org: SiteOrg;
  fullName: string;
  onClose: () => void;
  onStarted: (task: TaskItem) => void;
}

/** One merged PR becomes one task: the pipeline authors and verifies it in its own workflow. */
export function AddPrSheet({ org, fullName, onClose, onStarted }: AddPrSheetProps) {
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const input = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    input.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const submit = () => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    addPullRequest(org.login, fullName, value.trim()).then(
      (task) => {
        setBusy(false);
        onStarted(task);
      },
      (cause: Error) => {
        setBusy(false);
        setError(cause.message);
      },
    );
  };

  return (
    <div
      className="sheet-overlay"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside className="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="add-pr-title">
        <header className="sheet-head">
          <div>
            <div className="eyebrow">Add PR</div>
            <h2 id="add-pr-title">Build a Task From a Pull Request</h2>
            <p className="sheet-sub">
              A merged pull request in <span className="mono">{fullName}</span>. The pipeline
              authors a task from it, verifies it, and puts it up for review.
            </p>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <form
          className="sheet-lookup"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            ref={input}
            className="sheet-search"
            type="text"
            placeholder="PR number or URL"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-label="Pull request number or URL"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button type="submit" className="btn-primary" disabled={busy || !value.trim()}>
            {busy ? "Starting…" : "Build Task"}
          </button>
        </form>
        <div className="repo-list">
          {error ? (
            <p className="repo-note error">{error}</p>
          ) : (
            <p className="repo-note">
              Needs at least 20 changed lines. Easy from 20 lines, medium from 50 across two files,
              hard from 100 across three.
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}
