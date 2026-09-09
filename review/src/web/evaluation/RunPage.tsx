import React from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { CatalogModel, HostedSandbox } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { routeFor, thinkingOptions } from "../../../../src/evaluation/model-options";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, buttonStyles, Input, PageContent, PageHeader, Select } from "../ui";
import { type EvaluationOptions, evaluationRequest } from "./api";
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
          const valid =
            draft.tasks.length > 0 &&
            draft.tasks.every((task) =>
              result.tasks.some(
                (entry) => entry.runId === task.runId && entry.taskId === task.taskId,
              ),
            );
          setTasksReady(valid);
          if (!valid) setError("Select human-approved tasks from Dataset.");
        }
      },
      (cause) => {
        if (!disposed) setError(cause.message);
      },
    );
    return () => {
      disposed = true;
    };
  }, [url, draft.tasks, org.login]);
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
  const visible = [...models, custom].filter((model) =>
    `${model.label} ${model.model} ${model.provider}`.toLowerCase().includes(query.toLowerCase()),
  );
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
      const result = await evaluationRequest<{ id: string }>(`${url}/comparisons`, frozen);
      sessionStorage.removeItem(key);
      void navigate(`/repos/${repo}/comparisons/${result.id}`);
    } catch (cause) {
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
        title="Run Dataset"
        description={
          <>
            {draft.tasks.length} human-approved {draft.tasks.length === 1 ? "task" : "tasks"} · same
            frozen dataset for every model
          </>
        }
      >
        <Link
          className={buttonStyles.secondary}
          to={`/settings/credentials?return=${encodeURIComponent(`/repos/${repo}/run`)}`}
        >
          Manage Credentials
        </Link>
      </PageHeader>
      {error && (
        <p className="my-4 font-mono text-base text-danger" role="alert">
          {error}
        </p>
      )}
      {!draft.tasks.length && <Link to={`/repos/${repo}`}>Choose Tasks in Dataset →</Link>}
      <fieldset className="mt-6 min-w-0 border-0 p-0" disabled={busy || state.submitted}>
        <div className="flex flex-wrap items-center justify-between gap-4 border border-line-strong p-3 sm:px-4">
          <Input
            type="search"
            placeholder="Search Models or Providers…"
            aria-label="Search Models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="mt-2 text-sm text-muted">
            Predefined catalog · account access depends on your credentials
          </span>
        </div>
        <RunModelTable
          models={visible}
          credentials={credentials}
          draft={draft}
          onChange={(value) => setState({ draft: value, submitted: false })}
        />
        <div className="mt-6 flex flex-wrap items-end justify-between gap-4 [&_label]:grid [&_label]:gap-2.5 [&_label]:font-mono [&_label]:text-sm [&_label]:text-muted [&_strong]:text-sm">
          <label htmlFor="runpage-field-0">
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
          <label htmlFor="runpage-field-1">
            Sandbox Credential
            <Select
              id="runpage-field-1"
              aria-label="Sandbox Credential"
              value={draft.sandboxCredentialId}
              onChange={(event) =>
                setState({ ...state, draft: { ...draft, sandboxCredentialId: event.target.value } })
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
          <div>
            <strong>
              {selected.length} models · {pairs} combinations · {pairs * draft.tasks.length} trials
            </strong>
            <p className="mt-2 text-base text-muted">
              Model and cloud sandbox usage may incur charges. No automatic paid retries.
            </p>
          </div>
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-4 py-3.5">
        <Link to={`/settings/credentials?return=${encodeURIComponent(`/repos/${repo}/run`)}`}>
          Missing a credential? Add it in Settings
        </Link>
        <Button
          type="button"
          variant="primary"
          disabled={busy || (!state.submitted && !ready)}
          onClick={() => void submit()}
        >
          {busy
            ? "Saving Comparison…"
            : state.submitted
              ? "Retry Same Comparison"
              : "Run Comparison"}
        </Button>
      </div>
      {state.submitted && (
        <p className="mt-2 text-base text-muted">
          Selection locked after submission.{" "}
          <Link to={`/repos/${repo}/comparisons/${draft.id}`}>Check Saved Comparison</Link>.
          Returning from Settings preserves this request.
        </p>
      )}
    </PageContent>
  );
}
