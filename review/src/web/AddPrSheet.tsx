import React from "react";
import { addPrBatch } from "./add-pr-batch";
import { addPullRequest, fetchMergedPullRequests, type MergedPullRequest } from "./api";
import { Dialog, DialogFooter, DialogHeader } from "./Dialog";
import { GenerationFields } from "./GenerationFields";
import { GenerationSteps } from "./GenerationSteps";
import { PrSelectionList } from "./PrSelectionList";
import type { SiteOrg } from "./session";
import { Button, Notice } from "./ui";
import { useGenerationSettings } from "./useGenerationSettings";

export interface AddPrSheetProps {
  org: SiteOrg;
  fullName: string;
  onClose: () => void;
  onComplete: () => void;
}

/** One merged PR becomes one task: the pipeline authors and verifies it in its own workflow. */
export function AddPrSheet({ org, fullName, onClose, onComplete }: AddPrSheetProps) {
  const [search, setSearch] = React.useState("");
  const [step, setStep] = React.useState<1 | 2>(1);
  const {
    settings,
    setSettings,
    options,
    error: optionsError,
    valid,
    reload,
  } = useGenerationSettings(org.login, fullName);
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [started, setStarted] = React.useState<Set<number>>(new Set());
  const submitting = React.useRef(false);
  const [rows, setRows] = React.useState<MergedPullRequest[]>([]);
  const [page, setPage] = React.useState(1);
  const [nextPage, setNextPage] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [listError, setListError] = React.useState<string | null>(null);
  const [retry, setRetry] = React.useState(0);
  const [incomplete, setIncomplete] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{
    started: number;
    failed: { number: number; message: string }[];
  } | null>(null);
  const closeButton = React.useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly reloads the same page.
  React.useEffect(() => {
    let active = true;
    setLoading(true);
    setListError(null);
    fetchMergedPullRequests(org.login, fullName, page).then(
      (result) => {
        if (!active) return;
        setRows((previous) =>
          page === 1
            ? result.pullRequests
            : [
                ...previous,
                ...result.pullRequests.filter(
                  (row) => !previous.some((item) => item.number === row.number),
                ),
              ],
        );
        setNextPage(result.nextPage);
        setIncomplete(result.incomplete);
        setLoading(false);
      },
      (cause: Error) => {
        if (!active) return;
        setListError(cause.message);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [org.login, fullName, page, retry]);

  const query = search.trim().toLowerCase();
  const visible = rows.filter((pr) =>
    `${pr.title} #${pr.number} ${pr.author}`.toLowerCase().includes(query),
  );

  const submit = async () => {
    if (!selected.size || submitting.current || !valid) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const result = await addPrBatch(selected, (number) =>
      addPullRequest(org.login, fullName, String(number), settings),
    );
    setStarted((current) => new Set([...current, ...result.started.map((item) => item.number)]));
    setSelected(new Set(result.failed.map((item) => item.number)));
    submitting.current = false;
    setBusy(false);
    if (!result.failed.length) {
      onComplete();
      return;
    }
    setError({ started: result.started.length, failed: result.failed });
  };

  return (
    <Dialog
      initialFocus={closeButton}
      onDismiss={onClose}
      busy={busy}
      size={step === 1 ? "wide" : "large"}
      aria-labelledby="add-pr-title"
    >
      <section className="flex min-w-0 flex-col" aria-labelledby="add-pr-title">
        <DialogHeader
          title="Add PRs"
          titleId="add-pr-title"
          description={fullName}
          onClose={onClose}
          closeRef={closeButton}
          busy={busy}
        />
        <GenerationSteps step={step} firstStep="Select PRs" />
        {step === 1 ? (
          <PrSelectionList
            search={search}
            setSearch={setSearch}
            visible={visible}
            selected={selected}
            started={started}
            busy={busy}
            loading={loading}
            listError={listError}
            query={query}
            incomplete={incomplete}
            nextPage={nextPage}
            onToggle={(number) => {
              setSelected((current) => {
                const next = new Set(current);
                if (next.has(number)) next.delete(number);
                else next.add(number);
                return next;
              });
              setError(null);
            }}
            onRetry={() => setRetry((value) => value + 1)}
            onMore={() => {
              if (nextPage !== null) setPage(nextPage);
            }}
          />
        ) : (
          <div className="px-4 pb-6 sm:px-6">
            {optionsError && (
              <Notice className="mb-4">
                {optionsError} <Button onClick={reload}>Try Again</Button>
              </Notice>
            )}
            {!options && !optionsError ? (
              <p role="status" className="font-mono text-sm text-muted-foreground">
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
          </div>
        )}
        {error && (
          <div className="max-h-40 shrink-0 overflow-auto border-t border-border px-4 py-3 font-mono text-sm leading-5 sm:px-6">
            <p role="status" className="text-muted-foreground">
              {error.started > 0 && <span className="text-brand">{error.started} started · </span>}
              <span className="text-destructive">{error.failed.length} failed</span>
              <span> — failed PRs remain selected.</span>
            </p>
            <details className="mt-2 text-muted-foreground">
              <summary className="w-fit cursor-pointer hover:text-foreground">
                Technical Details
              </summary>
              <ul className="mt-2 space-y-1 break-words">
                {error.failed.map((item) => (
                  <li key={item.number}>
                    PR #{item.number}: {item.message}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
        <DialogFooter className="sticky bottom-0 justify-between">
          <span className="font-mono text-sm text-muted-foreground">{selected.size} Selected</span>
          <div className="ml-auto flex gap-3">
            {step === 2 && (
              <Button variant="ghost" disabled={busy} onClick={() => setStep(1)}>
                Back
              </Button>
            )}
            <Button
              variant="primary"
              disabled={busy || selected.size === 0 || (step === 2 && !valid)}
              onClick={() => (step === 1 ? setStep(2) : void submit())}
            >
              {busy ? "Starting…" : step === 1 ? "Continue" : "Generate Tasks"}
            </Button>
          </div>
        </DialogFooter>
      </section>
    </Dialog>
  );
}
