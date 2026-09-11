import React from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { CatalogModel, HostedSandbox } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { routeFor, thinkingOptions } from "../../../../src/evaluation/model-options";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, fieldStyles, Notice, PageContent, PageHeader, Select } from "../ui";
import { type EvaluationOptions, evaluationRequest, evaluationRequestId } from "./api";
import { submitComparison, UnsavedComparisonError } from "./comparison-submission";
import { RunModelPicker } from "./RunModelPicker";
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
  const [picking, setPicking] = React.useState(false);
  const [query, setQuery] = React.useState("");
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
        description={`${draft.tasks.length} accepted ${draft.tasks.length === 1 ? "task" : "tasks"}`}
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
      {!draft.tasks.length && (
        <Link to={`/repos/${repo}`}>No accepted tasks yet. Review Dataset →</Link>
      )}
      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <fieldset className="min-w-0 border-0 p-0" disabled={busy || state.submitted}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium">Models and Harnesses</h2>
            <Button type="button" onClick={() => setPicking(!picking)} aria-expanded={picking}>
              + Add Model / Harness
            </Button>
          </div>
          <RunModelPicker
            picking={picking}
            visible={[...models, custom]}
            draft={draft}
            credentials={credentials}
            query={query}
            setQuery={setQuery}
            setPicking={setPicking}
            state={state}
            setState={setState}
          />
          <RunModelTable
            models={draft.models
              .map((selection) =>
                [...models, custom].find((model) => model.id === selection.catalogId),
              )
              .filter((model): model is CatalogModel => !!model)}
            credentials={credentials}
            draft={draft}
            onChange={(value) => setState({ draft: value, submitted: false })}
          />
        </fieldset>
        <aside className="border border-border bg-card p-5">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-sm font-medium">Execution</h2>
            <Link
              className="text-xs text-muted-foreground hover:text-foreground"
              to={`/settings/credentials?return=${encodeURIComponent(`/repos/${repo}/run`)}`}
            >
              Credentials
            </Link>
          </div>
          <fieldset className="grid min-w-0 gap-4 border-0 p-0" disabled={busy || state.submitted}>
            <label className={fieldStyles} htmlFor="runpage-field-0">
              Sandbox
              <Select
                id="runpage-field-0"
                aria-label="Sandbox"
                value={draft.sandbox}
                onChange={(event) =>
                  setState({
                    ...state,
                    draft: {
                      ...draft,
                      sandbox: event.target.value as HostedSandbox,
                      sandboxCredentialId: "",
                    },
                  })
                }
              >
                {sandboxes.map((sandbox) => (
                  <option key={sandbox} value={sandbox}>
                    {sandbox === "e2b" ? "E2B" : sandbox === "modal" ? "Modal" : "Daytona"}
                  </option>
                ))}
              </Select>
            </label>
            <label className={fieldStyles} htmlFor="runpage-field-1">
              Sandbox Credential
              <Select
                id="runpage-field-1"
                aria-label="Sandbox Credential"
                value={draft.sandboxCredentialId}
                onChange={(event) =>
                  setState({
                    ...state,
                    draft: { ...draft, sandboxCredentialId: event.target.value },
                  })
                }
              >
                <option value="">Select Credential</option>
                {credentials
                  .filter((entry) => entry.kind === draft.sandbox)
                  .map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
              </Select>
            </label>
          </fieldset>
          <div className="mt-5 border-t border-border pt-4">
            <div className="mb-4 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Total Trials</span>
              <span>{pairs * draft.tasks.length}</span>
            </div>
            <Button
              type="button"
              variant="primary"
              className="w-full"
              disabled={busy || (!state.submitted && !ready)}
              onClick={() => void submit()}
            >
              {busy
                ? "Saving Comparison…"
                : state.submitted
                  ? "Retry Same Comparison"
                  : "Run Comparison"}
            </Button>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Model and sandbox usage is billed by your providers.
            </p>
          </div>
        </aside>
      </div>
    </PageContent>
  );
}
