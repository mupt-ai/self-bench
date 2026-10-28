import React from "react";
import { Link, useNavigate } from "react-router";
import type { CatalogModel, HostedSandbox } from "../../../../src/evaluation/catalog";
import { requestJson } from "../api";
import type { Benchmark } from "../benchmarks/api";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { covered, setupCoverage } from "../setup/readiness";
import { useOrgCredentials } from "../setup/SetupStatus";
import { Button, Notice, PageContent, PageHeader } from "../ui";
import { evaluationRequest, evaluationRequestId } from "./api";
import {
  resumeComparison,
  submitComparison,
  UnsavedComparisonError,
} from "./comparison-submission";
import { RunBlockerNotice, RunExecution, RunSetupCallout, runBlocker } from "./RunExecution";
import { judgeCredentials, RunJudgePanel } from "./RunJudgePanel";
import { RunModelsPanel } from "./RunModelsPanel";
import { type BenchmarkRunState, restoreBenchmarkDraft } from "./run-draft";
import { runCredentials, selectionReady } from "./run-readiness";
import { useEvaluationScope } from "./useEvaluationScope";

/** A benchmark's Run page: models and harnesses against its Harbor registry dataset. */
export function BenchmarkRunPage() {
  const { url } = useEvaluationScope();
  return <BenchmarkRunContent key={url} />;
}

function BenchmarkRunContent() {
  const { org } = useOrg();
  const { url, pages, label } = useEvaluationScope();
  useDocumentTitle(`Run · ${label}`);
  const navigate = useNavigate();
  const key = `selfbench-run:${url}`;
  const [state, setState] = React.useState<BenchmarkRunState>(() => {
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(key);
    } catch {}
    return restoreBenchmarkDraft(saved);
  });
  const [models, setModels] = React.useState<CatalogModel[]>([]);
  const [sandboxes, setSandboxes] = React.useState<HostedSandbox[]>([]);
  const [credentials, credentialsError] = useOrgCredentials(org.login);
  const [managed, setManaged] = React.useState<{ models: boolean; sandbox: boolean }>();
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [benchmark, setBenchmark] = React.useState<Benchmark>();
  const { draft } = state;
  React.useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(state));
    } catch {}
  }, [key, state]);
  React.useEffect(() => {
    let disposed = false;
    evaluationRequest<{
      models: CatalogModel[];
      sandboxes: HostedSandbox[];
      managed?: { models: boolean; sandbox: boolean };
    }>(`${url}/catalog`).then(
      (result) => {
        if (disposed) return;
        setModels(result.models);
        setSandboxes(result.sandboxes);
        setManaged(result.managed ?? { models: false, sandbox: false });
        // A new draft starts on the platform's sandbox when it offers one.
        setState((current) =>
          !current.sandboxDefaultPending || current.submitted
            ? current
            : {
                ...current,
                sandboxDefaultPending: false,
                draft: result.managed?.sandbox
                  ? { ...current.draft, sandbox: "managed", sandboxCredentialId: "managed-sandbox" }
                  : current.draft,
              },
        );
      },
      (cause) => {
        if (!disposed) setError(cause.message);
      },
    );
    // How many tasks the dataset had when added, for the trial count.
    requestJson<{ benchmark: Benchmark }>(url.replace(/\/evaluations$/, "")).then(
      (result) => !disposed && setBenchmark(result.benchmark),
      (cause: Error) => !disposed && setError(cause.message),
    );
    return () => {
      disposed = true;
    };
  }, [url]);
  const availableCredentials = runCredentials(credentials, managed?.models);
  const selected = draft.models.filter((model) => model.harnesses.length > 0);
  const pairs = selected.reduce((count, model) => count + model.harnesses.length, 0);
  // Tasks graded by an LLM need a credential for it, which the run fills their judge variables from.
  const judge = benchmark?.judge;
  const judgeReady =
    !judge?.variables.length ||
    judgeCredentials(credentials ?? []).some((entry) => entry.id === draft.judgeCredentialId);
  const ready =
    !!benchmark &&
    judgeReady &&
    selectionReady({
      draft,
      models,
      credentials: availableCredentials,
      managedSandbox: !!managed?.sandbox,
    });
  const coverage =
    credentials && managed && !state.submitted && setupCoverage(credentials, managed).evaluate;
  const blocker =
    !judgeReady && !state.submitted && managed
      ? "Select a judge credential to continue."
      : runBlocker({ draft, ready, submitted: state.submitted, tasksReady: !!managed, pairs });
  const submit = async (missingOnly = false) => {
    if (busy || (!state.submitted && !ready)) return;
    setBusy(true);
    setError("");
    const frozen = state.submitted
      ? draft
      : { ...draft, models: selected, skipCompleted: missingOnly };
    const pending = { draft: frozen, submitted: true };
    setState(pending);
    try {
      sessionStorage.setItem(key, JSON.stringify(pending));
    } catch {}
    try {
      const result = await submitComparison(url, frozen);
      if (result.submissionError) {
        setError(result.submissionError ?? "Some runs were not submitted. Resume to finish them.");
        return;
      }
      sessionStorage.removeItem(key);
      void navigate(`${pages}/results`);
    } catch (cause) {
      if (cause instanceof UnsavedComparisonError) setState({ draft: frozen, submitted: false });
      setError(
        cause instanceof Error
          ? cause.message
          : "Submission not confirmed. Retry uses the same ID.",
      );
    } finally {
      setBusy(false);
    }
  };
  const resume = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await resumeComparison(url, draft.id);
      if (result.submissionError) {
        setError(result.submissionError ?? "Some runs were not submitted. Resume to finish them.");
        return;
      }
      sessionStorage.removeItem(key);
      void navigate(`${pages}/results`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not resume submission");
    } finally {
      setBusy(false);
    }
  };
  return (
    <PageContent>
      <PageHeader
        className="mb-6"
        title="Run"
        description={`Compare models and harnesses on ${label} from Harbor's registry.`}
      />
      {state.submitted && (
        <div className="panel mb-5 flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm">These settings belong to a submitted request.</p>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              className="text-sm font-semibold text-foreground underline underline-offset-4"
              to={`${pages}/results`}
            >
              View Results
            </Link>
            <Button type="button" variant="primary" disabled={busy} onClick={() => void resume()}>
              {busy ? "Resuming…" : "Resume Submission"}
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setState({ submitted: false, draft: { ...draft, id: evaluationRequestId() } });
                setError("");
              }}
            >
              New Comparison
            </Button>
          </div>
        </div>
      )}
      {(error || credentialsError) && <Notice className="mb-5">{error || credentialsError}</Notice>}
      {coverage && !covered(coverage) ? (
        <RunSetupCallout coverage={coverage} />
      ) : (
        blocker && <RunBlockerNotice>{blocker}</RunBlockerNotice>
      )}
      {judge?.variables.length ? (
        <RunJudgePanel
          pages={pages}
          needs={judge}
          credentials={credentials ?? []}
          value={draft.judgeCredentialId}
          onChange={(judgeCredentialId) =>
            setState((current) => ({ ...current, draft: { ...current.draft, judgeCredentialId } }))
          }
          disabled={busy || state.submitted}
        />
      ) : null}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <RunModelsPanel
          models={models}
          credentials={availableCredentials}
          draft={draft}
          disabled={busy || state.submitted}
          onChange={(value) => setState({ ...state, draft: value, submitted: false })}
        />
        <RunExecution
          pages={pages}
          draft={draft}
          credentials={availableCredentials}
          sandboxes={managed?.sandbox ? ["managed", ...sandboxes] : sandboxes}
          submitted={state.submitted}
          busy={busy}
          ready={ready}
          pairs={pairs}
          taskCount={benchmark?.tasks ?? 0}
          onChange={(value) => setState({ ...state, draft: value, sandboxDefaultPending: false })}
          onSubmit={() => void submit()}
          onRunMissing={() => void submit(true)}
        />
      </div>
    </PageContent>
  );
}
