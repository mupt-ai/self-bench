import type { PublicResults } from "../contract";
import { ModelSummaries } from "./ModelSummaries";
import { OpenTask } from "./OpenTask";
import { OpenTrace } from "./OpenTrace";
import { ResultsGrid } from "./ResultsGrid";
import { TaskList } from "./TaskList";

/**
 * What a release published beyond its scores, below its chart and table, on a repository's,
 * public benchmark's, or group's page alike: its model summaries, each setting's result on each
 * task, and its tasks. `activeId` is the setting the chart or table is pointing at.
 */
export function ReleaseSections({
  release,
  activeId,
}: {
  release: PublicResults;
  activeId: string | null;
}) {
  return (
    <>
      <ModelSummaries release={release} activeId={activeId} />
      {release.trialsPublished && <ResultsGrid release={release} activeId={activeId} />}
      {release.tasksPublished && <TaskList release={release} />}
    </>
  );
}

/** The task and trace viewers a published release's page opens from its address. */
export function ReleaseViewers({ release }: { release: PublicResults }) {
  return (
    <>
      {release.tasksPublished && <OpenTask release={release} />}
      {release.trialsPublished && <OpenTrace release={release} />}
    </>
  );
}
