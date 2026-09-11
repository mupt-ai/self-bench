import { ArrowRight, Layers } from "lucide-react";
import { Link } from "react-router";
import { batchIsTerminal } from "../batch-api";
import { useBatches } from "./BatchProvider";
import { batchPath } from "./presentation";

export function BatchActivity() {
  const { repoId, runs, statuses, errors, error } = useBatches();
  if (!error && !runs?.length) return null;
  const active = (runs ?? []).filter(
    (run) => statuses[run.runId] && !batchIsTerminal(statuses[run.runId].phase),
  ).length;
  const blocked = (runs ?? []).filter((run) =>
    ["blocked", "failed"].includes(statuses[run.runId]?.phase),
  ).length;
  const unavailable = error || (runs ?? []).some((run) => errors[run.runId]);
  return (
    <Link
      to={batchPath(repoId.fullName)}
      className="mb-6 flex flex-wrap items-center justify-between gap-3 border border-border bg-card px-4 py-3 hover:bg-muted/50"
      aria-label="View Batch Activity"
    >
      <span className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="inline-flex items-center gap-2 text-sm">
          <Layers className="size-4 text-muted-foreground" aria-hidden="true" />
          Batch Activity
        </span>
        <span className="text-xs text-muted-foreground">
          {runs
            ? `${runs.length} ${runs.length === 1 ? "Batch" : "Batches"}`
            : "History Unavailable"}
        </span>
        {active > 0 && <span className="text-xs text-brand">{active} Running</span>}
        {blocked > 0 && (
          <span className="text-xs text-destructive">
            {blocked} {blocked === 1 ? "Needs Attention" : "Need Attention"}
          </span>
        )}
        {unavailable && <span className="text-xs text-destructive">Status Unavailable</span>}
      </span>
      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        View Batches
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </span>
    </Link>
  );
}
