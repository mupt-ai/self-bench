import { useEffect, useState } from "react";
import type { TaskItem } from "../api";
import { type BatchStatus, batchIsTerminal, fetchBatch } from "../batch-api";
import { StateStamp } from "./state";

export function LiveTaskState({
  task,
  org,
  fullName,
}: {
  task: TaskItem;
  org: string;
  fullName: string;
}) {
  const [status, setStatus] = useState<BatchStatus>();
  useEffect(() => {
    if (!task.runId.startsWith("batch-") || task.state !== "in_progress") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await fetchBatch({ org, fullName }, task.runId);
        if (disposed) return;
        setStatus(result);
        if (batchIsTerminal(result.phase)) return;
      } catch {
        if (!disposed) setStatus(undefined);
      }
      if (!disposed) timer = setTimeout(() => void refresh(), 3000);
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [task.runId, task.state, org, fullName]);
  if (!task.runId.startsWith("batch-") || task.state !== "in_progress")
    return <StateStamp state={task.state} />;
  const progress = status?.tasks?.find((entry) => entry.candidateId === task.candidateId);
  const activity = status?.activity?.[task.candidateId];
  const stage =
    progress?.status === "reviewing" || progress?.status === "verifying"
      ? "Verification"
      : "Authoring";
  const label =
    progress?.status === "accepted"
      ? "Verified"
      : progress?.status === "rejected"
        ? "Rejected"
        : progress?.status === "infrastructure_failed"
          ? "Failed"
          : status && batchIsTerminal(status.phase)
            ? "Stopped"
            : activity === "running"
              ? `Running · ${stage}`
              : activity === "queued"
                ? `Queued · ${stage}`
                : "Checking Status…";
  return (
    <span
      role="status"
      className={activity === "running" ? "text-sm text-brand" : "text-sm text-muted-foreground"}
    >
      {label}
    </span>
  );
}
