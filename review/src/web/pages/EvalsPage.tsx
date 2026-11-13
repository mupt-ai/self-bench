import { FlaskConical } from "lucide-react";
import React from "react";
import { useNavigate } from "react-router";
import { EVAL_OWNER, MAX_EVAL_NAME_LENGTH } from "../../../../src/contracts/evals";
import {
  type ConnectedRepo,
  disconnectRepo,
  fetchConnectedRepos,
  fetchTaskCounts,
  formatAgo,
  type RepoTaskCounts,
} from "../api";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "../Dialog";
import { createEval } from "../evals-api";
import { CardGridSkeleton } from "../LoadingSkeleton";
import { InfoTooltip } from "../primitives/tooltip";
import { AddScopeButton, ScopeCard } from "../ScopeCard";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, fieldStyles, Input, Notice, PageFrame, PageHeader } from "../ui";

/**
 * Evals: the workspace's own collections of workspace scenarios, with no repository behind them.
 * Each has a dataset, Run, and Results, at /repos/evals/<slug>.
 */
export function EvalsPage() {
  const { org } = useOrg();
  const navigate = useNavigate();
  useDocumentTitle(`Vibe Evals · ${org.login}`);
  const [evals, setEvals] = React.useState<ConnectedRepo[]>();
  const [counts, setCounts] = React.useState<Record<string, RepoTaskCounts>>({});
  const [error, setError] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    setEvals(undefined);
    fetchConnectedRepos(org.login).then(
      (found) => !cancelled && setEvals(found.filter((repo) => repo.kind === "eval")),
      (cause: Error) => !cancelled && setError(cause.message),
    );
    fetchTaskCounts(org.login).then(
      (found) => !cancelled && setCounts(found),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [org.login]);
  const remove = (entry: ConnectedRepo) => {
    if (!window.confirm(`Delete ${nameOf(entry)} and its tasks?`)) return;
    disconnectRepo(org.login, entry.fullName).then(
      () => setEvals((current) => current?.filter((item) => item.fullName !== entry.fullName)),
      (cause: Error) => setError(cause.message),
    );
  };
  return (
    <PageFrame>
      <PageHeader title="Vibe Evals" description="Evals built from tasks you describe." />
      {error && <Notice className="mb-4">{error}</Notice>}
      {!evals && !error && <CardGridSkeleton label="Loading Vibe Evals" />}
      {evals && (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {evals.map((entry) => {
            const count = counts[entry.fullName];
            return (
              <li key={entry.fullName}>
                <ScopeCard
                  name={nameOf(entry)}
                  to={`/repos/${entry.fullName}`}
                  icon={
                    <FlaskConical
                      className="size-5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  }
                  details={[`Created ${formatAgo(entry.connectedAt)}`]}
                  stats={[
                    { label: "Tasks", value: count ? count.total - count.rejected : 0 },
                    {
                      label: "Needs Review",
                      value: count?.needsReview ?? 0,
                      attention: !!count?.needsReview,
                    },
                    { label: "Accepted", value: count ? count.accepted : 0 },
                  ]}
                  removeLabel="Delete"
                  onRemove={() => remove(entry)}
                />
              </li>
            );
          })}
          <li>
            <AddScopeButton label="New Eval" onClick={() => setCreating(true)} />
          </li>
        </ul>
      )}
      {creating && (
        <NewEvalDialog
          org={org.login}
          onClose={() => setCreating(false)}
          onCreated={(entry) => navigate(`/repos/${entry.fullName}`)}
        />
      )}
    </PageFrame>
  );
}

/** An eval is named by its slug, without the reserved `evals/` owner. */
function nameOf(entry: ConnectedRepo): string {
  return entry.fullName.slice(EVAL_OWNER.length + 1);
}

function NewEvalDialog({
  org,
  onClose,
  onCreated,
}: {
  org: string;
  onClose: () => void;
  onCreated: (entry: ConnectedRepo) => void;
}) {
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const closeButton = React.useRef<HTMLButtonElement>(null);
  const submit = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createEval(org, name.trim()));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };
  return (
    <Dialog
      initialFocus={closeButton}
      onDismiss={onClose}
      busy={busy}
      aria-labelledby="new-eval-title"
    >
      <form
        className="flex min-w-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <DialogHeader
          title="New Eval"
          titleId="new-eval-title"
          onClose={onClose}
          closeRef={closeButton}
          busy={busy}
        />
        <DialogBody>
          <label htmlFor="eval-name" className={fieldStyles}>
            <span className="flex items-center gap-1.5">
              Name
              <InfoTooltip label="A collection of workspace vibe evals with no repository behind it, such as the tasks one capability or product area should handle. It gets its own dataset, Run, and Results." />
            </span>
            <Input
              id="eval-name"
              aria-label="Name"
              // A name, not a login: keep browsers and password managers from offering one.
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              maxLength={MAX_EVAL_NAME_LENGTH}
              placeholder="Data Import Bugs"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {error && <Notice>{error}</Notice>}
        </DialogBody>
        <DialogFooter className="justify-end">
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create Eval"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
