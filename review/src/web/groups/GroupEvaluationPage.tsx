import { Square } from "lucide-react";
import React from "react";
import { Link, useParams } from "react-router";
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

/** One group evaluation: each repository's progress, then repositories against settings. */
export function GroupEvaluationPage() {
  const { org } = useOrg();
  const { groupId = "", evaluationId = "" } = useParams();
  const url = groupsUrl(org.login, groupId, "evaluations", evaluationId);
  const [evaluation, setEvaluation] = React.useState<GroupEvaluation>();
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  useDocumentTitle(`Evaluation · ${evaluation?.groupName ?? "Repository Group"}`);
  const statuses =
    evaluation?.repos.flatMap((repo) =>
      "progress" in repo ? repo.progress.runs.map((run) => run.status) : [],
    ) ?? [];
  const running = statuses.some(unfinished);
  // A run still pending was never confirmed as submitted; resuming submits it with its ID.
  const unsubmitted = statuses.includes("pending");
  React.useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () =>
      requestJson<GroupEvaluation>(url).then(
        (result) => {
          if (disposed) return;
          setEvaluation(result);
          setError("");
          const live = result.repos.some(
            (repo) =>
              "progress" in repo && repo.progress.runs.some((run) => unfinished(run.status)),
          );
          if (live) timer = setTimeout(poll, 10_000);
        },
        (cause) => {
          if (!disposed) setError(cause.message);
        },
      );
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [url]);
  const act = async (action: "resume" | "cancel") => {
    setBusy(true);
    try {
      const result = await evaluationRequest<GroupEvaluation>(`${url}/${action}`, {});
      setEvaluation(result);
      setError(result.submissionError ?? "");
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
            {unsubmitted && (
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
