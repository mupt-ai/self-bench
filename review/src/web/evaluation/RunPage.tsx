import React from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { CatalogModel, HostedSandbox } from "../../../../src/evaluation/catalog";
import { evaluationTaskKey } from "../../../../src/evaluation/models";
import type { JudgeNeeds } from "../../../../src/harnesses/harbor/host-variables";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { covered, setupCoverage } from "../setup/readiness";
import { useOrgCredentials } from "../setup/SetupStatus";
import { Button, Notice, PageContent, PageHeader } from "../ui";
import { type EvaluationOptions, evaluationRequest, evaluationRequestId } from "./api";
import {
  type ComparisonReceipt,
  resumeComparison,
  submitComparison,
  UnsavedComparisonError,
} from "./comparison-submission";
import { ResourceWarnings } from "./ResourceWarnings";
import {
  RunBlockerNotice,
  type RunDraft,
  RunExecution,
  RunSetupCallout,
  runBlocker,
} from "./RunExecution";
import { judgeCredentials, RunJudgePanel } from "./RunJudgePanel";
import { RunMissing } from "./RunMissing";
import { RunModelsPanel } from "./RunModelsPanel";
import { RunTaskPicker } from "./RunTaskPicker";
import { restoreRunDraft } from "./run-draft";
import { runCredentials, selectionReady } from "./run-readiness";
import { type EvaluationScope, useEvaluationScope } from "./useEvaluationScope";

type RunState = { draft: RunDraft; submitted: boolean; sandboxDefaultPending?: boolean };

/**
 * A repository's or benchmark's Run page: models and harnesses against the tasks picked from its
 * dataset, with a credential for their LLM judge when they have one.
 */
export function RunPage() {
  const scope = useEvaluationScope();
  return <RunContent key={scope.url} scope={scope} />;
}
function RunContent({ scope }: { scope: EvaluationScope }) {
  const { url, pages, label } = scope;
  const { org } = useOrg();
  useDocumentTitle(`Run · ${label}`);
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const key = `selfbench-run:${url}`;
  const [state, setState] = React.useState<RunState>(() => {
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(key);
    } catch {}
    return restoreRunDraft(saved, search.get("tasks"));
  });
  const [models, setModels] = React.useState<CatalogModel[]>([]);
  const [sandboxes, setSandboxes] = React.useState<HostedSandbox[]>([]);
  const [credentials, credentialsError] = useOrgCredentials(org.login);
  const [managed, setManaged] = React.useState<{ models: boolean; sandbox: boolean }>();
  const [availableTasks, setAvailableTasks] = React.useState<EvaluationOptions["tasks"]>([]);
  const [judge, setJudge] = React.useState<JudgeNeeds>();
  const [error, setError] = React.useState("");
  const [warnings, setWarnings] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [tasksReady, setTasksReady] = React.useState(false);
  const { draft } = state;
  React.useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(state));
      if (search.has("tasks")) setSearch({}, { replace: true });
    } catch {}
  }, [key, state, search, setSearch]);
  React.useEffect(() => {
    let disposed = false;
    setTasksReady(false);
    evaluationRequest<{
      models: CatalogModel[];
      sandboxes: HostedSandbox[];
      managed?: { models: boolean; sandbox: boolean };
    }>(`${url}/catalog`).then(
      (result) => {
        if (!disposed) {
          setModels(result.models);
          setSandboxes(result.sandboxes);
          setManaged(result.managed ?? { models: false, sandbox: false });
          setState((current) => {
            if (!current.sandboxDefaultPending || current.submitted) return current;
            return {
              ...current,
              sandboxDefaultPending: false,
              draft: result.managed?.sandbox
                ? { ...current.draft, sandbox: "managed", sandboxCredentialId: "managed-sandbox" }
                : current.draft,
            };
          });
        }
      },
      (cause) => {
        if (!disposed) setError(cause.message);
      },
    );
    evaluationRequest<EvaluationOptions>(`${url}/options`).then(
      (result) => {
        if (!disposed) {
          setAvailableTasks(result.tasks);
          setJudge(result.judge);
          setState((current) => {
            if (current.submitted) return current;
            const available = new Set(
              result.tasks.map((task) => evaluationTaskKey(task.runId, task.taskId)),
            );
            const selectedTasks = current.draft.tasks.filter((task) =>
              available.has(evaluationTaskKey(task.runId, task.taskId)),
            );
            const tasks =
              selectedTasks.length || current.draft.tasks.length
                ? selectedTasks
                : // A variant runs only when picked, as Run Task and Variants does.
                  result.tasks
                    .filter((task) => !task.variant)
                    .map(({ runId, taskId }) => ({ runId, taskId }));
            return { ...current, draft: { ...current.draft, tasks } };
          });
          setTasksReady(true);
        }
      },
      (cause) => {
        if (!disposed) {
          setTasksReady(true);
          setError(cause.message);
        }
      },
    );
    return () => {
      disposed = true;
    };
  }, [url]);
  const availableCredentials = runCredentials(credentials, managed?.models);
  const selected = draft.models.filter((model) => model.harnesses.length > 0);
  const pairs = selected.reduce((count, model) => count + model.harnesses.length, 0);
  // Tasks graded by an LLM need a credential for it, which the run fills their judge variables from.
  const judgeReady =
    !judge?.variables.length ||
    judgeCredentials(credentials ?? []).some((entry) => entry.id === draft.judgeCredentialId);
  const ready =
    tasksReady &&
    draft.tasks.length > 0 &&
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
    !judgeReady && tasksReady && !state.submitted
      ? "Select a judge credential to continue."
      : runBlocker({ draft, ready, submitted: state.submitted, tasksReady, pairs });
  const finish = (result: ComparisonReceipt) => {
    if (result.submissionError) return setError(result.submissionError);
    sessionStorage.removeItem(key);
    if (result.resourceWarnings?.length) setWarnings(result.resourceWarnings);
    else void navigate(`${pages}/results`);
  };
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
      finish(await submitComparison(url, frozen));
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
      finish(await resumeComparison(url, draft.id));
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
        description={
          scope.kind !== "benchmark"
            ? "Compare models and harnesses against your accepted tasks."
            : `Compare models and harnesses on ${label} from Harbor's registry.`
        }
      />
      {tasksReady && !state.submitted && (
        <RunMissing url={url} pages={pages} tasks={availableTasks} />
      )}
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
                setWarnings([]);
              }}
            >
              New Comparison
            </Button>
          </div>
        </div>
      )}
      {(error || credentialsError) && <Notice className="mb-5">{error || credentialsError}</Notice>}
      <ResourceWarnings warnings={warnings} onContinue={() => void navigate(`${pages}/results`)} />
      {coverage && !covered(coverage) ? (
        <RunSetupCallout coverage={coverage} />
      ) : (
        blocker && <RunBlockerNotice>{blocker}</RunBlockerNotice>
      )}
      <RunTaskPicker
        scope={scope}
        availableTasks={availableTasks}
        picked={draft.tasks}
        tasksReady={tasksReady}
        onChange={(tasks) =>
          setState((current) => ({ ...current, draft: { ...current.draft, tasks } }))
        }
        disabled={busy || state.submitted}
      />
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
          onChange={(value) => setState({ ...state, draft: value, sandboxDefaultPending: false })}
          onSubmit={() => void submit()}
          onRunMissing={() => void submit(true)}
        />
      </div>
    </PageContent>
  );
}
