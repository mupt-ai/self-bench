import { Plus } from "lucide-react";
import React from "react";
import { useNavigate, useParams } from "react-router";
import { AGENT_MINUTES } from "../../../../src/contracts/agent-limit";
import type { CatalogModel, HostedSandbox } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { requestJson } from "../api";
import { evaluationRequest, evaluationRequestId } from "../evaluation/api";
import { customModel } from "../evaluation/model-selection";
import { RunBlockerNotice, RunExecution } from "../evaluation/RunExecution";
import { RunModelTable } from "../evaluation/RunModelTable";
import { credentialsWithManaged, settingsReady } from "../evaluation/run-readiness";
import { InfoTooltip } from "../primitives/tooltip";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { useOrgCredentials } from "../setup/SetupStatus";
import { Breadcrumbs, Button, fieldStyles, Input, Notice, PageFrame, PageHeader } from "../ui";
import { type GroupDetail, type GroupEvaluation, type GroupSettings, groupsUrl } from "./api";

type Draft = GroupSettings & { id: string };

/** The Run page's models and sandbox, for every approved task of each repository in a group. */
export function GroupRunPage() {
  const { org } = useOrg();
  const { groupId = "" } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = React.useState<GroupDetail>();
  const [models, setModels] = React.useState<CatalogModel[]>([]);
  const [sandboxes, setSandboxes] = React.useState<HostedSandbox[]>([]);
  const [managed, setManaged] = React.useState<{ models: boolean; sandbox: boolean }>();
  const [credentials, credentialsError] = useOrgCredentials(org.login);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState<Draft>(() => ({
    id: evaluationRequestId(),
    models: [{ catalogId: "", credentialId: "", harnesses: [] }],
    sandbox: "e2b",
    sandboxCredentialId: "",
    agentMinutes: AGENT_MINUTES.default,
  }));
  useDocumentTitle(`Run · ${detail?.group.name ?? "Repository Group"}`);
  React.useEffect(() => {
    let disposed = false;
    requestJson<GroupDetail>(groupsUrl(org.login, groupId)).then(
      (result) => {
        if (!disposed) setDetail(result);
      },
      (cause) => {
        if (!disposed) setError(cause.message);
      },
    );
    requestJson<{
      models: CatalogModel[];
      sandboxes: HostedSandbox[];
      managed?: { models: boolean; sandbox: boolean };
    }>(groupsUrl(org.login, "catalog")).then(
      (result) => {
        if (disposed) return;
        setModels(result.models);
        setSandboxes(result.sandboxes);
        setManaged(result.managed ?? { models: false, sandbox: false });
        if (result.managed?.sandbox)
          setDraft((current) =>
            current.sandboxCredentialId
              ? current
              : { ...current, sandbox: "managed", sandboxCredentialId: "managed-sandbox" },
          );
      },
      (cause) => {
        if (!disposed) setError(cause.message);
      },
    );
    return () => {
      disposed = true;
    };
  }, [org.login, groupId]);
  const available = credentialsWithManaged(managed, credentials);
  const tasks = detail?.group.repos.reduce((sum, repo) => sum + repo.approvedTasks, 0) ?? 0;
  const repos = detail?.group.repos.filter((repo) => repo.approvedTasks > 0).length ?? 0;
  const pairs = draft.models.reduce((count, model) => count + model.harnesses.length, 0);
  const minutesValid =
    Number.isInteger(draft.agentMinutes) &&
    draft.agentMinutes >= AGENT_MINUTES.min &&
    draft.agentMinutes <= AGENT_MINUTES.max;
  const ready =
    tasks > 0 && minutesValid && settingsReady({ draft, models, credentials: available, managed });
  // The shared run components edit a comparison; a group evaluation has no task list.
  const comparison: ComparisonDraft = { ...draft, tasks: [] };
  const edit = ({ tasks: _, skipCompleted: __, ...value }: ComparisonDraft) =>
    setDraft((current) => ({ ...value, agentMinutes: current.agentMinutes }));
  const submit = async () => {
    if (busy || !ready) return;
    setBusy(true);
    setError("");
    try {
      const result = await evaluationRequest<GroupEvaluation>(
        groupsUrl(org.login, groupId, "evaluations"),
        { ...draft, models: draft.models.filter((model) => model.harnesses.length > 0) },
      );
      void navigate(`/groups/${groupId}/evaluations/${result.id}`);
    } catch (cause) {
      // The ID stays, so a retry finishes this submission rather than starting another.
      setError(cause instanceof Error ? cause.message : "Submission not confirmed. Retry safely.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <PageFrame>
      <Breadcrumbs
        items={[
          { label: "Repository Groups", to: "/groups" },
          { label: detail?.group.name ?? "…", to: `/groups/${groupId}` },
          { label: "Run" },
        ]}
      />
      <PageHeader
        className="mb-6"
        title="Run Group Evaluation"
        description={`Runs every approved task in ${repos} of ${detail?.group.repos.length ?? 0} repositories, as one comparison per repository.`}
      />
      {(error || credentialsError) && <Notice className="mb-5">{error || credentialsError}</Notice>}
      {!ready && !busy && detail && (
        <RunBlockerNotice>
          {tasks === 0
            ? "Approve tasks in a repository of this group to continue."
            : !pairs
              ? "Add a model to continue."
              : !draft.sandboxCredentialId
                ? "Select a sandbox credential to continue."
                : !minutesValid
                  ? `Set agent minutes from ${AGENT_MINUTES.min} to ${AGENT_MINUTES.max}.`
                  : "Check the credentials and harness for each model."}
        </RunBlockerNotice>
      )}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="grid min-w-0 gap-5">
          <fieldset className="panel min-w-0 p-0" disabled={busy}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">Models and Harnesses</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {draft.models.length} of 12 configurations
                </p>
              </div>
              <InfoTooltip label="Add Model">
                <Button
                  size="icon"
                  aria-label="Add Model"
                  disabled={
                    draft.models.length >= 12 || draft.models.some((model) => !model.catalogId)
                  }
                  onClick={() =>
                    setDraft({
                      ...draft,
                      models: [...draft.models, { catalogId: "", credentialId: "", harnesses: [] }],
                    })
                  }
                >
                  <Plus className="size-4" aria-hidden="true" />
                </Button>
              </InfoTooltip>
            </div>
            <RunModelTable
              models={[...models, customModel]}
              credentials={available}
              draft={comparison}
              onChange={edit}
            />
          </fieldset>
          <fieldset className="panel grid gap-2 p-4" disabled={busy}>
            <label className={fieldStyles} htmlFor="group-agent-minutes">
              <span className="flex items-center gap-1.5">
                Agent Minutes
                <InfoTooltip label="How long the agent may work on each task. Every repository uses the same limit, so their results compare." />
              </span>
              <Input
                id="group-agent-minutes"
                type="number"
                className="max-w-32"
                min={AGENT_MINUTES.min}
                max={AGENT_MINUTES.max}
                value={draft.agentMinutes}
                onChange={(event) =>
                  setDraft({ ...draft, agentMinutes: Number(event.target.value) })
                }
              />
            </label>
          </fieldset>
        </div>
        <RunExecution
          returnTo={`/groups/${groupId}/run`}
          noun="Group Evaluation"
          taskCount={tasks}
          draft={comparison}
          credentials={available}
          sandboxes={managed?.sandbox ? ["managed", ...sandboxes] : sandboxes}
          submitted={false}
          busy={busy}
          ready={ready}
          pairs={pairs}
          onChange={edit}
          onSubmit={() => void submit()}
        />
      </div>
    </PageFrame>
  );
}
