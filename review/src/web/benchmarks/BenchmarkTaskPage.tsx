import React from "react";
import { useParams } from "react-router";
import type { TaskSource } from "../../sources/types";
import type { CandidateArtifacts } from "../../types";
import { pageGutter } from "../layout";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { TaskView } from "../task/TaskView";
import { Breadcrumbs } from "../ui";
import { benchmarkTaskFiles } from "./api";

/**
 * One benchmark task in the repository task view: its files as frozen when the benchmark was
 * added. A registry task has no generation pipeline or review, so there is nothing to approve.
 */
export function BenchmarkTaskPage() {
  const { org } = useOrg();
  const { owner = "", name = "", "*": taskId = "" } = useParams();
  const fullName = `${owner}/${name}`;
  useDocumentTitle(`${taskId} · ${fullName} · SelfBench`);
  const source = React.useMemo(
    () => benchmarkTaskSource(org.login, fullName, taskId),
    [org.login, fullName, taskId],
  );
  return (
    <div className="grid h-full min-h-0 min-w-0 flex-none grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
      <header className={`border-b border-border bg-background py-5 ${pageGutter}`}>
        <Breadcrumbs
          items={[
            { label: "Benchmarks", to: "/benchmarks" },
            { label: fullName, to: `/benchmarks/${fullName}`, mono: true },
            { label: "Task" },
          ]}
        />
        <h1 className="font-mono text-xl leading-7 font-medium wrap-anywhere">{taskId}</h1>
        <p className="mt-1 text-sm text-muted-foreground">From Harbor's registry</p>
      </header>
      <TaskView key={taskId} source={source} row={{ id: taskId, name: taskId }} />
    </div>
  );
}

/** The task view's source for a benchmark task: one bundle, and no pipeline to show. */
function benchmarkTaskSource(org: string, fullName: string, taskId: string): TaskSource {
  const files = () => benchmarkTaskFiles(org, fullName, taskId);
  const artifacts = async (): Promise<CandidateArtifacts> => ({
    runId: fullName,
    taskId,
    candidateId: taskId,
    groups: {} as CandidateArtifacts["groups"],
    bundles: [{ key: taskId, sizeBytes: 0, stage: "verify" }],
    agents: [],
  });
  return {
    kind: "run",
    label: fullName,
    rows: [{ id: taskId, name: taskId }],
    artifacts,
    loadBundle: files,
    loadFiles: files,
  };
}
