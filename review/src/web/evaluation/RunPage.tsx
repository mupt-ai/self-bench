import { ArrowRight, Database, Plus } from "lucide-react";
import React from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { CatalogModel, HostedSandbox } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { routeFor, thinkingOptions } from "../../../../src/evaluation/model-options";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, Notice, PageContent, PageHeader } from "../ui";
import { type EvaluationOptions, evaluationRequest, evaluationRequestId } from "./api";
import { submitComparison, UnsavedComparisonError } from "./comparison-submission";
import { RunExecution } from "./RunExecution";
import { RunModelTable } from "./RunModelTable";
import { restoreRunDraft } from "./run-draft";
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
    evaluationRequest<{ models: CatalogModel[]; sandboxes: HostedSandbox[] }>(
      `${url}/catalog`,
    ).then(
      (result) => {
        if (!disposed) {
          setModels(result.models);
          setSandboxes(result.sandboxes);
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
          const tasks = result.tasks.map(({ runId, taskId }) => ({ runId, taskId }));
          setState((current) =>
            current.submitted ? current : { ...current, draft: { ...current.draft, tasks } },
          );
          setTasksReady(!state.submitted && tasks.length > 0);
        }
      },
      (cause) => {
        if (!disposed) setError(cause.message);
      },
    );
    return () => {
      disposed = true;
    };
  }, [url, org.login, state.submitted]);
  const selected = draft.models.filter((model) => model.harnesses.length > 0);
  const pairs = selected.reduce((count, model) => count + model.harnesses.length, 0);
  const custom: CatalogModel = {
    id: "custom",
    provider: "custom",
    model: "",
    label: "Custom Model",
    harnesses: ["pi"],
    source: "",
  };
  const ready =
    tasksReady &&
    selected.length > 0 &&
    selected.length === draft.models.length &&
    selected.length <= 12 &&
    credentials.some(
      (credential) =>
        credential.id === draft.sandboxCredentialId && credential.kind === draft.sandbox,
    ) &&
    selected.every((selection) => {
      const model =
        selection.catalogId === "custom"
          ? custom
          : models.find((entry) => entry.id === selection.catalogId);
      const credential = credentials.find((entry) => entry.id === selection.credentialId);
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
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    const frozen = state.submitted ? draft : { ...draft, models: selected };
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
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-border bg-card p-4">
          <p className="text-sm">These settings belong to a submitted request.</p>
          <div className="flex flex-wrap items-center gap-3">
            <Link className="text-sm text-brand" to={`/repos/${repo}/comparisons/${draft.id}`}>
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
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border border-border bg-card px-4 py-3">
        <div className="flex items-center gap-3">
          <Database className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium">
              {draft.tasks.length} {draft.tasks.length === 1 ? "Accepted Task" : "Accepted Tasks"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {draft.tasks.length
                ? "Each configuration runs against the same dataset."
                : "Accept tasks in your dataset before starting a comparison."}
            </p>
          </div>
        </div>
        <Link
          className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
          to={`/repos/${repo}`}
        >
          Review Dataset <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <fieldset
          className="min-w-0 border border-border bg-card p-0"
          disabled={busy || state.submitted}
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-medium">Models and Harnesses</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {draft.models.length} of 12 configurations
              </p>
            </div>
            <Button
              type="button"
              size="icon"
              aria-label="Add Model"
              title="Add Model"
              disabled={draft.models.length >= 12 || draft.models.some((model) => !model.catalogId)}
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
          </div>
          <RunModelTable
            models={[...models, custom]}
            credentials={credentials}
            draft={draft}
            onChange={(value) => setState({ draft: value, submitted: false })}
          />
        </fieldset>
        <RunExecution
          repo={repo}
          draft={draft}
          credentials={credentials}
          sandboxes={sandboxes}
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
