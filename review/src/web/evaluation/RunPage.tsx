import { Plus } from "lucide-react";
import React from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel, HostedSandbox } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { evaluationTaskKey, routeFor, thinkingOptions } from "../../../../src/evaluation/models";
import { InfoTooltip } from "../primitives/tooltip";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, Notice, PageContent, PageHeader } from "../ui";
import { type EvaluationOptions, evaluationRequest, evaluationRequestId } from "./api";
import { submitComparison, UnsavedComparisonError } from "./comparison-submission";
import { customModel, hasDuplicateModelSelections } from "./model-selection";
import { RunExecution } from "./RunExecution";
import { RunModelTable } from "./RunModelTable";
import { RunTaskPicker } from "./RunTaskPicker";
import { preferManagedSandbox, restoreRunDraft } from "./run-draft";
import { useEvaluationScope } from "./useEvaluationScope";
export function RunPage() {
  const scope = useEvaluationScope();
  return <RunContent key={scope.url} {...scope} />;
}
function RunContent({ repo, url }: { repo: string; url: string }) {
  const { org } = useOrg();
  useDocumentTitle(`Run · ${repo}`);
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const key = `selfbench-run:${url}`;
  const [state, setState] = React.useState<{ draft: ComparisonDraft; submitted: boolean }>(() => {
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(key);
    } catch {}
    return restoreRunDraft(saved, search.get("tasks"));
  });
  const [models, setModels] = React.useState<CatalogModel[]>([]);
  const [sandboxes, setSandboxes] = React.useState<HostedSandbox[]>([]);
  const [credentials, setCredentials] = React.useState<CredentialInfo[]>([]);
  const [managed, setManaged] = React.useState({ models: false, sandbox: false });
  const [availableTasks, setAvailableTasks] = React.useState<EvaluationOptions["tasks"]>([]);
  const [error, setError] = React.useState("");
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
          if (result.managed?.sandbox) setState(preferManagedSandbox);
        }
      },
      (cause) => {
        if (!disposed) setError(cause.message);
      },
    );
    evaluationRequest<{ credentials: CredentialInfo[] }>(
      `/api/orgs/${encodeURIComponent(org.login)}/credentials`,
    ).then(
      (result) => {
        if (!disposed) setCredentials(result.credentials);
      },
      (cause) => {
        if (!disposed) setError(cause.message);
      },
    );
    evaluationRequest<EvaluationOptions>(`${url}/options`).then(
      (result) => {
        if (!disposed) {
          setAvailableTasks(result.tasks);
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
                : result.tasks.map(({ runId, taskId }) => ({ runId, taskId }));
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
  }, [url, org.login]);
  const availableCredentials: CredentialInfo[] = [
    ...(managed.models
      ? [
          {
            id: "managed-model",
            name: "Managed",
            kind: "openrouter" as const,
            auth: "api-key" as const,
            createdAt: "",
          },
        ]
      : []),
    ...(managed.sandbox
      ? [
          {
            id: "managed-sandbox",
            name: "Managed",
            kind: "e2b" as const,
            auth: "api-key" as const,
            createdAt: "",
          },
        ]
      : []),
    ...credentials,
  ];
  const selected = draft.models.filter((model) => model.harnesses.length > 0);
  const pairs = selected.reduce((count, model) => count + model.harnesses.length, 0);
  const ready =
    tasksReady &&
    draft.tasks.length > 0 &&
    selected.length > 0 &&
    selected.length === draft.models.length &&
    !hasDuplicateModelSelections([...models, customModel], draft.models) &&
    selected.length <= 12 &&
    availableCredentials.some(
      (credential) =>
        credential.id === draft.sandboxCredentialId &&
        (draft.sandbox === "managed"
          ? credential.id === "managed-sandbox"
          : credential.kind === draft.sandbox),
    ) &&
    selected.every((selection) => {
      const model =
        selection.catalogId === "custom"
          ? customModel
          : models.find((entry) => entry.id === selection.catalogId);
      const credential = availableCredentials.find((entry) => entry.id === selection.credentialId);
      if (!model || !credential) return false;
      const route = routeFor(model, credential.kind);
      const levels = thinkingOptions(model, selection.harnesses);
      return (
        !!route &&
        selection.harnesses.every((harness) => route.harnesses.includes(harness)) &&
        (credential.auth !== "codex-login" ||
          selection.harnesses.every((harness) => harness === "codex")) &&
        (!selection.thinking || levels.includes(selection.thinking)) &&
        (model.id !== "custom" || !!selection.customModel)
      );
    });
  const submit = async (missingOnly = false) => {
    if (busy || (!state.submitted && !ready)) return;
    setBusy(true);
    setError("");
    const frozen = state.submitted
      ? draft
      : { ...draft, models: selected, skipCompleted: missingOnly || draft.skipCompleted };
    const pending = { draft: frozen, submitted: true };
    setState(pending);
    try {
      sessionStorage.setItem(key, JSON.stringify(pending));
    } catch {}
    try {
      const result = await submitComparison(url, frozen);
      sessionStorage.removeItem(key);
      void navigate(`/repos/${repo}/comparisons/${result.id}`);
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
  return (
    <PageContent>
      <PageHeader
        title="Run"
        description="Compare models and harnesses against your accepted tasks."
      />
      {state.submitted && (
        <div className="panel mb-4 flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm">These settings belong to a submitted request.</p>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              className="text-sm font-semibold text-foreground underline underline-offset-4"
              to={`/repos/${repo}/comparisons/${draft.id}`}
            >
              View Status
            </Link>
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
      {error && <Notice className="mb-4">{error}</Notice>}
      <RunTaskPicker
        repo={repo}
        availableTasks={availableTasks}
        draft={draft}
        tasksReady={tasksReady}
        onChange={(tasks) =>
          setState((current) => ({ ...current, draft: { ...current.draft, tasks } }))
        }
        onSkipCompleted={(skipCompleted) =>
          setState((current) => ({ ...current, draft: { ...current.draft, skipCompleted } }))
        }
        onRunMissing={() => void submit(true)}
        canRun={ready}
        disabled={busy || state.submitted}
      />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <fieldset className="panel min-w-0 p-0" disabled={busy || state.submitted}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Models and Harnesses</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {draft.models.length} of 12 configurations
              </p>
            </div>
            <InfoTooltip label="Add Model">
              <Button
                type="button"
                size="icon"
                aria-label="Add Model"
                disabled={
                  draft.models.length >= 12 || draft.models.some((model) => !model.catalogId)
                }
                onClick={() =>
                  setState({
                    draft: {
                      ...draft,
                      models: [...draft.models, { catalogId: "", credentialId: "", harnesses: [] }],
                    },
                    submitted: false,
                  })
                }
              >
                <Plus className="size-4" aria-hidden="true" />
              </Button>
            </InfoTooltip>
          </div>
          <RunModelTable
            models={[...models, customModel]}
            credentials={availableCredentials}
            draft={draft}
            onChange={(value) => setState({ draft: value, submitted: false })}
          />
        </fieldset>
        <RunExecution
          repo={repo}
          draft={draft}
          credentials={availableCredentials}
          sandboxes={managed.sandbox ? ["managed", ...sandboxes] : sandboxes}
          submitted={state.submitted}
          busy={busy}
          ready={ready}
          tasksReady={tasksReady}
          pairs={pairs}
          onChange={(value) => setState({ ...state, draft: value })}
          onSubmit={() => void submit()}
        />
      </div>
    </PageContent>
  );
}
