import React from "react";
import { Link, useParams } from "react-router";
import { ListSkeleton } from "../LoadingSkeleton";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { DataTable, Notice, PageContent, PageHeader, SearchInput } from "../ui";
import { type BenchmarkTask, fetchBenchmarkTasks } from "./api";

/** A benchmark's tasks, as frozen when it was added; each opens its own task page. */
export function BenchmarkDatasetPage() {
  const { org } = useOrg();
  const { owner = "", name = "" } = useParams();
  const fullName = `${owner}/${name}`;
  useDocumentTitle(`Dataset · ${fullName} · SelfBench`);
  const [tasks, setTasks] = React.useState<BenchmarkTask[]>();
  const [error, setError] = React.useState("");
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    let disposed = false;
    setTasks(undefined);
    fetchBenchmarkTasks(org.login, fullName).then(
      (found) => !disposed && setTasks(found),
      (cause: Error) => !disposed && setError(cause.message),
    );
    return () => {
      disposed = true;
    };
  }, [org.login, fullName]);
  const needle = query.trim().toLowerCase();
  const shown = tasks?.filter((task) => task.taskId.toLowerCase().includes(needle)) ?? [];
  return (
    <PageContent>
      <PageHeader
        title="Dataset"
        description={
          tasks
            ? `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} from Harbor's registry, as checked when this benchmark was added.`
            : "Tasks from Harbor's registry."
        }
      />
      {error && <Notice className="mb-4">{error}</Notice>}
      {!tasks && !error && <ListSkeleton label="Loading Tasks" />}
      {tasks && (
        <>
          <SearchInput
            className="mb-4 max-w-sm"
            placeholder="Search Tasks"
            aria-label="Search Tasks"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <DataTable>
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col" className="hidden sm:table-cell">
                  Digest
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((task) => (
                <tr key={task.taskId}>
                  <td className="font-mono text-sm wrap-anywhere">
                    <Link
                      className="hover:underline hover:underline-offset-4"
                      to={`/benchmarks/${fullName}/tasks/${task.taskId}`}
                    >
                      {task.taskId}
                    </Link>
                  </td>
                  <td className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                    {task.runId.replace(/^harbor:sha256:/, "").slice(0, 12)}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          {shown.length === 0 && (
            <p className="mt-4 text-sm text-muted-foreground">No tasks match.</p>
          )}
        </>
      )}
    </PageContent>
  );
}
