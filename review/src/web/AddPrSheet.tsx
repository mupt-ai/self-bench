import React from "react";
import {
  type GenerationSettings,
  generationSettingsSchema,
} from "../../../src/site/generation-settings";
import { addPrBatch } from "./add-pr-batch";
import {
  addPullRequest,
  fetchGenerationOptions,
  fetchMergedPullRequests,
  type MergedPullRequest,
} from "./api";
import { GenerationFields, type GenerationOptions } from "./GenerationFields";
import { PrSelectionList } from "./PrSelectionList";
import type { SiteOrg } from "./session";
import { useModalDialog } from "./useModalDialog";

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
  const [options, setOptions] = React.useState<GenerationOptions | null>(null);
  const [optionsError, setOptionsError] = React.useState<string | null>(null);
  const [settings, setSettings] = React.useState<GenerationSettings>({
    authorModel: "gpt-5.6-sol",
    verifierModel: "gpt-5.6-sol",
    reasoning: "high",
    sandbox: "modal",
    modelCredentialId: "",
  });
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
  const dialog = useModalDialog(closeButton);
  React.useEffect(() => {
    let active = true;
    const refresh = () =>
      void fetchGenerationOptions(org.login, fullName).then(
        (result) => {
          if (active) {
            setOptions(result);
            setOptionsError(null);
          }
        },
        (cause) => {
          if (active) setOptionsError(cause.message);
        },
      );
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [org.login, fullName]);

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
    if (
      !selected.size ||
      submitting.current ||
      !options?.available ||
      !generationSettingsSchema.safeParse(settings).success
    )
      return;
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
    <dialog
      ref={dialog}
      aria-labelledby="add-pr-title"
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting.current) onClose();
      }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-[920px] overflow-auto border border-line-strong bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/70"
    >
      <section className="flex min-w-0 flex-col bg-surface" aria-labelledby="add-pr-title">
        <header className="flex items-start justify-between gap-4 px-5 pt-6 pb-5 sm:px-6">
          <div className="min-w-0">
            <h1 id="add-pr-title" className="font-mono text-lg font-semibold text-ink">
              Add PRs
            </h1>
            <p className="mt-2 font-mono text-[13px] leading-5 text-muted break-all">{fullName}</p>
          </div>
          <button
            ref={closeButton}
            type="button"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center border border-transparent text-muted hover:border-line-strong hover:text-ink"
            aria-label="Close"
            title="Close"
            disabled={busy}
            onClick={onClose}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </header>
        <ol className="mx-5 mb-6 flex gap-6 border-b border-line pb-4 font-mono text-[13px] sm:mx-6">
          <li
            className={step === 1 ? "text-mint" : "text-muted"}
            aria-current={step === 1 ? "step" : undefined}
          >
            1. Select PRs
          </li>
          <li
            className={step === 2 ? "text-mint" : "text-muted"}
            aria-current={step === 2 ? "step" : undefined}
          >
            2. Configure Generation
          </li>
        </ol>
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
          <div className="px-5 pb-8 sm:px-6">
            {optionsError && (
              <p role="alert" className="mb-4 font-mono text-sm text-danger">
                {optionsError}
              </p>
            )}
            {!options && !optionsError ? (
              <p role="status" className="font-mono text-sm text-muted">
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
          <div className="max-h-40 shrink-0 overflow-auto border-t border-line px-5 py-3 font-mono text-[13px] leading-5 sm:px-6">
            <p role="status" className="text-muted">
              {error.started > 0 && <span className="text-mint">{error.started} started · </span>}
              <span className="text-danger">{error.failed.length} failed</span>
              <span> — failed PRs remain selected.</span>
            </p>
            <details className="mt-2 text-muted">
              <summary className="w-fit cursor-pointer hover:text-ink">Technical Details</summary>
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
        <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface px-5 py-4 sm:px-6">
          <span className="font-mono text-[13px] text-muted">{selected.size} Selected</span>
          <div className="ml-auto flex gap-3">
            {step === 2 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setStep(1)}
                className="px-3 font-mono text-[13px] text-muted hover:text-ink"
              >
                Back
              </button>
            )}
            <button
              type="button"
              className="inline-flex h-9 shrink-0 items-center justify-center gap-2 border border-mint bg-mint px-4 font-sans text-[13px] font-bold text-bg hover:bg-mint-bright disabled:cursor-not-allowed disabled:opacity-40"
              disabled={
                busy ||
                selected.size === 0 ||
                (step === 2 &&
                  (!options?.available || !generationSettingsSchema.safeParse(settings).success))
              }
              onClick={() => (step === 1 ? setStep(2) : void submit())}
            >
              {busy ? "Starting…" : step === 1 ? "Continue" : "Generate Tasks"}
            </button>
          </div>
        </footer>
      </section>
    </dialog>
  );
}
