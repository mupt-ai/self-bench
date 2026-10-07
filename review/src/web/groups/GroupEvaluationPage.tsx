import { Square } from "lucide-react";
import React from "react";
import { Link, useLocation, useParams } from "react-router";
import { requestJson } from "../api";
import { evaluationRequest } from "../evaluation/api";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import {
  Breadcrumbs,
  Button,
  DataTable,
  Notice,
  PageFrame,
  PageHeader,
  RunStatus,
  SectionHeader,
} from "../ui";
import { type GroupEvaluation, groupsUrl } from "./api";
import { GroupMatrixTable } from "./GroupMatrixTable";
import { settingsLabel } from "./settings-label";

const unfinished = (status: string) =>
  status === "pending" || status === "queued" || status === "running";
const statusesOf = (evaluation: GroupEvaluation | undefined) =>
  evaluation?.repos.flatMap((repo) =>
    "progress" in repo ? repo.progress.runs.map((run) => run.status) : [],
  ) ?? [];
/** Still going: a comparison not saved yet, or a run not finished. */
const live = (evaluation: GroupEvaluation | undefined) =>
  !!evaluation?.repos.some((repo) => "unsaved" in repo) || statusesOf(evaluation).some(unfinished);

/** One group evaluation: each repository's progress, then repositories against settings. */
export function GroupEvaluationPage() {
  const { org } = useOrg();
  const { groupId = "", evaluationId = "" } = useParams();
  const url = groupsUrl(org.login, groupId, "evaluations", evaluationId);
  const [evaluation, setEvaluation] = React.useState<GroupEvaluation>();
  // A submission whose runs were not all confirmed says so on the page it lands on.
  const { state } = useLocation() as { state?: { submissionError?: string } };
  const [warning, setWarning] = React.useState(state?.submissionError);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  useDocumentTitle(`Evaluation · ${evaluation?.groupName ?? "Repository Group"}`);
  const statuses = statusesOf(evaluation);
  const unsaved = !!evaluation?.repos.some((repo) => "unsaved" in repo);
  const running = live(evaluation);
  const [polls, setPolls] = React.useState(0);
  // Resuming saves a comparison an interrupted submission left out, and starts every run that
  // was never confirmed as started, with its own ID.
  const resumable =
    unsaved || statuses.some((status) => status === "pending" || status === "queued");
  // biome-ignore lint/correctness/useExhaustiveDependencies: a resume or cancel restarts polling.
  React.useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () =>
      requestJson<GroupEvaluation>(url).then(
        (result) => {
          if (disposed) return;
          setEvaluation(result);
          setError("");
          if (live(result)) timer = setTimeout(poll, 10_000);
        },
        (cause) => {
          if (disposed) return;
          setError(cause.message);
          // A failed read is retried, so a long evaluation's page never goes stale.
          timer = setTimeout(poll, 30_000);
        },
      );
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [url, polls]);
  const act = async (action: "resume" | "cancel") => {
    setBusy(true);
    try {
      const result = await evaluationRequest<GroupEvaluation>(`${url}/${action}`, {});
      setEvaluation(result);
      setWarning(result.submissionError);
      setError("");
      setPolls((count) => count + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };
  const ran = evaluation?.repos.flatMap((repo) => ("runs" in repo ? [repo] : [])) ?? [];
  return (
    <PageFrame>
      <Breadcrumbs
        items={[
          { label: "Repository Groups", to: "/groups" },
          { label: evaluation?.groupName ?? "…", to: `/groups/${groupId}` },
          { label: "Evaluation" },
        ]}
      />
      <PageHeader
        title={evaluation ? `${evaluation.groupName} Evaluation` : "Group Evaluation"}
        description={
          evaluation &&
          `${settingsLabel(evaluation.settings)} · ${evaluation.settings.agentMinutes} agent minutes · started by ${evaluation.createdBy} on ${new Date(evaluation.createdAt).toLocaleString()}`
        }
      >
        {running && (
          <>
            {resumable && (
              <Button size="small" disabled={busy} onClick={() => void act("resume")}>
                Resume Submission
              </Button>
            )}
            <Button size="small" disabled={busy} onClick={() => void act("cancel")}>
              <Square className="size-4" aria-hidden="true" />
              Cancel Evaluation
            </Button>
          </>
        )}
      </PageHeader>
      {warning && <Notice className="mb-6">{warning}</Notice>}
      {error && <Notice className="mb-6">{error}</Notice>}
      {evaluation && (
        <section className="mb-8">
          <SectionHeader title="Progress" />
          <DataTable>
            <thead>
              <tr>
                <th>Repository</th>
                <th>Status</th>
                <th>Trials Finished</th>
              </tr>
            </thead>
            <tbody>
              {evaluation.repos.map((repo) => (
                <tr key={repo.fullName}>
                  <td>
                    {"comparisonId" in repo ? (
                      <Link
                        className="font-mono text-xs hover:underline"
                        to={`/repos/${repo.fullName}/comparisons/${repo.comparisonId}`}
                      >
                        {repo.fullName}
                      </Link>
                    ) : (
                      <span className="font-mono text-xs">{repo.fullName}</span>
                    )}
                  </td>
                  <td>
                    {"progress" in repo ? (
                      <RunStatus value={statusOf(repo.progress.runs.map((run) => run.status))} />
                    ) : "unsaved" in repo ? (
                      <span className="text-xs text-muted-foreground">
                        Not saved yet; resume to submit it.
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">{repo.skipped}</span>
                    )}
                  </td>
                  <td className="tabular-nums">
                    {"progress" in repo &&
                      `${repo.progress.runs.reduce((sum, run) => sum + run.completed, 0)} / ${repo.progress.runs.reduce((sum, run) => sum + run.trials, 0)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </section>
      )}
      {ran.length > 0 && (
        <section>
          <SectionHeader
            title="Results"
            description="Pass rate and model cost per task of each setting in each repository. The average counts each repository once; pooled counts each task once."
          />
          <GroupMatrixTable repos={ran} />
        </section>
      )}
    </PageFrame>
  );
}

/** A repository's status from its runs': still going while any is, failed if any failed. */
function statusOf(statuses: string[]): string {
  if (statuses.some((status) => status === "running")) return "running";
  if (statuses.some((status) => status === "queued" || status === "pending")) return "queued";
  if (statuses.some((status) => status === "failed")) return "failed";
  return "completed";
}
