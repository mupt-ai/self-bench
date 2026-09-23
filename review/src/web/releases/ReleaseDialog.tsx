import { CircleAlert, X } from "lucide-react";
import React from "react";
import { formatAgo, plural } from "../api";
import { Dialog, DialogBody } from "../Dialog";
import { ListSkeleton } from "../LoadingSkeleton";
import { InfoTooltip } from "../primitives/tooltip";
import { Button, Notice } from "../ui";
import { ReleaseRequestError, type ReleaseSummary, type ReleaseView, releaseRequest } from "./api";
import { SettingsPicker } from "./SettingsPicker";
import { selectionOf } from "./selection";

/** What becomes public and what stays private, shown on the info icon beside the summary. */
function privacyNote(workspace: { login: string; kind: "org" | "user" }): string {
  const publisher =
    workspace.kind === "user"
      ? `you as publisher, under your GitHub username ${workspace.login}`
      : `the ${workspace.login} workspace as publisher`;
  return `Public: the repository, ${publisher}, and each setting's model, harness, accuracy, and cost. Private: which tasks and pull requests were used, per-task results, transcripts, endpoint hosts, and who pressed Release.`;
}

/**
 * Publishes the repository's results on selfbench.dev. Fetches its own fresh preview, lets the
 * releaser tick settings, and shows exactly what would be public. A 409 swaps in the server's
 * fresh preview and says why; pressing Release again is the deliberate retry.
 */
export function ReleaseDialog({
  url,
  workspace,
  onReleased,
  onClose,
}: {
  url: string;
  /** The publishing workspace: a GitHub org, or the person's own account. */
  workspace: { login: string; kind: "org" | "user" };
  onReleased(release: ReleaseSummary, unchanged: boolean): void;
  onClose(): void;
}) {
  const cancel = React.useRef<HTMLButtonElement>(null);
  const [view, setView] = React.useState<ReleaseView>();
  const [ticked, setTicked] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [query, setQuery] = React.useState("");
  const show = React.useCallback((next: ReleaseView, keep?: ReadonlySet<string>) => {
    setView(next);
    const available = new Set(next.preview.settings.map((setting) => setting.key));
    setTicked(
      keep
        ? new Set([...keep].filter((key) => available.has(key)))
        : new Set(next.preview.settings.filter((setting) => setting.ticked).map((s) => s.key)),
    );
  }, []);
  React.useEffect(() => {
    let disposed = false;
    releaseRequest<ReleaseView>(`${url}/preview`).then(
      (next) => !disposed && show(next),
      (cause) => !disposed && setError(cause instanceof Error ? cause.message : "Could not load"),
    );
    return () => {
      disposed = true;
    };
  }, [url, show]);

  const selection = view ? selectionOf(view.preview, ticked) : undefined;
  // What a freshly opened dialog ticks; Reset returns here.
  const defaults = React.useMemo(
    () =>
      new Set(
        view?.preview.settings.filter((setting) => setting.ticked).map((setting) => setting.key),
      ),
    [view],
  );
  const unchanged =
    query === "" && ticked.size === defaults.size && [...ticked].every((key) => defaults.has(key));
  const blocked = !selection || selection.settings === 0 || selection.tasks.length === 0;
  const release = async () => {
    if (!view) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await releaseRequest<{ release: ReleaseSummary; unchanged?: boolean }>(url, {
        settings: [...ticked],
        head: view.head?.id ?? null,
        fingerprint: view.preview.fingerprint,
      });
      onReleased(result.release, result.unchanged === true);
    } catch (cause) {
      if (cause instanceof ReleaseRequestError && cause.fresh) {
        show(cause.fresh, ticked);
        setNotice(cause.message);
      } else setError(cause instanceof Error ? cause.message : "Could not release");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      initialFocus={cancel}
      onDismiss={onClose}
      busy={busy}
      size="large"
      className="max-w-5xl"
      aria-labelledby="release-title"
      aria-describedby="release-description"
    >
      <header className="flex items-start justify-between gap-4 px-4 pt-4 sm:px-6 sm:pt-5">
        <div className="min-w-0">
          <h2 id="release-title" className="text-base font-semibold tracking-tight">
            Release Results
          </h2>
          <p id="release-description" className="mt-0.5 text-sm text-muted-foreground">
            Publish this repository's results on selfbench.dev, where anyone can see them.
          </p>
        </div>
        <button
          type="button"
          aria-label="Close"
          disabled={busy}
          onClick={onClose}
          className="-mt-0.5 -mr-1.5 inline-flex size-7 shrink-0 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </header>
      <DialogBody className="space-y-4 pt-4 sm:pt-4">
        {notice && (
          <p role="status" className="flex items-start gap-2 text-sm text-foreground">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            {notice}
          </p>
        )}
        {error && <Notice>{error}</Notice>}
        {!view ? (
          !error && <ListSkeleton label="Loading Preview" />
        ) : view.preview.settings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing to release yet. Run models on approved tasks first; every completed, verified
            result counts.
          </p>
        ) : (
          <>
            <SettingsPicker
              settings={view.preview.settings}
              tasks={view.preview.tasks.length}
              ticked={ticked}
              query={query}
              disabled={busy}
              onQuery={setQuery}
              onChange={setTicked}
            />
            {selection && <Notes view={view} selection={selection} />}
          </>
        )}
        {/* One line when the dialog is wide. Narrow: the summary alone on top, then Reset on the
            left and Cancel and Release on the right. */}
        <div className="@container pt-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
            {view && view.preview.settings.length > 0 && (
              <Button
                className="order-2 @2xl:order-1"
                disabled={busy || unchanged}
                onClick={() => {
                  setQuery("");
                  setTicked(new Set(defaults));
                }}
              >
                Reset
              </Button>
            )}
            <div className="order-1 min-w-0 basis-full @2xl:order-2 @2xl:flex-1 @2xl:basis-auto">
              <div className="flex items-center gap-1.5 text-sm font-medium" aria-live="polite">
                <span>
                  {!selection
                    ? ""
                    : selection.settings === 0
                      ? "Tick at least one setting."
                      : selection.tasks.length === 0
                        ? "The ticked settings have no approved task in common."
                        : `Releases ${plural(selection.settings, "setting")} on ${plural(selection.tasks.length, "task")}.`}
                </span>
                {selection && (
                  <InfoTooltip
                    label={privacyNote(workspace)}
                    contentClassName="border border-border bg-card text-foreground"
                  />
                )}
              </div>
              {view && view.preview.settings.length > 0 && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {view.current
                    ? `Last released by ${view.current.releasedBy} ${formatAgo(view.current.releasedAt)}: ${plural(view.current.settings, "setting")} on ${plural(view.current.tasks, "task")}.`
                    : "Not released yet."}
                </p>
              )}
            </div>
            <div className="order-3 ml-auto flex shrink-0 gap-2">
              <Button ref={cancel} disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy || blocked} onClick={() => void release()}>
                {busy ? "Releasing…" : "Release"}
              </Button>
            </div>
          </div>
        </div>
      </DialogBody>
    </Dialog>
  );
}

/** What changes against the current release, as short notes above the summary line. */
function Notes({
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
