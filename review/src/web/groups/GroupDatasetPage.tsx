import React from "react";
import { Link, useParams } from "react-router";
import type { EvaluationOptions } from "../evaluation/api";
import { ListSkeleton } from "../LoadingSkeleton";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { taskPath } from "../task/review-queue";
import { DifficultyStamp } from "../task/state";
import { DataTable, Notice, PageContent, PageHeader, SearchInput } from "../ui";
import { matchesQuery } from "../word-search";
import { fetchGroup, type GroupView, groupRequest, groupsUrl } from "./api";

/** A group's dataset: its members, and every approved task of theirs, each opening its own page. */
export function GroupDatasetPage() {
  const { org } = useOrg();
  const { slug = "" } = useParams();
  const [group, setGroup] = React.useState<GroupView>();
  const [tasks, setTasks] = React.useState<EvaluationOptions["tasks"]>();
  const [error, setError] = React.useState("");
  const [query, setQuery] = React.useState("");
  useDocumentTitle(`Dataset · ${group?.name ?? slug} · SelfBench`);
  React.useEffect(() => {
    let disposed = false;
    Promise.all([
      fetchGroup(org.login, slug),
      groupRequest<EvaluationOptions>(groupsUrl(org.login, slug, "/evaluations/options")),
    ]).then(
      ([found, options]) => {
        if (disposed) return;
        setGroup(found);
        setTasks(options.tasks);
      },
      (cause: Error) => !disposed && setError(cause.message),
    );
    return () => {
      disposed = true;
    };
  }, [org.login, slug]);
  const shown =
    tasks?.filter((task) => matchesQuery(`${task.repository ?? ""} ${task.taskId}`, query)) ?? [];
  return (
    <PageContent>
      <PageHeader
        title={group?.name ?? "Dataset"}
        description={
          group
            ? group.description ||
              `Every approved task of ${group.repositories.length} repositories, run together.`
            : undefined
        }
      />
      {error && <Notice className="mb-4">{error}</Notice>}
      {!tasks && !error && <ListSkeleton label="Loading Tasks" />}
      {group && tasks && (
        <div className="flex flex-col gap-8">
          <DataTable>
            <thead>
              <tr>
                <th scope="col">Repository</th>
                <th scope="col">Approved Tasks</th>
              </tr>
            </thead>
            <tbody>
              {group.repositories.map((member) => (
                <tr key={member.id}>
                  <td className="font-mono">
                    {member.connected ? (
                      <Link className="hover:underline" to={`/repos/${member.fullName}`}>
                        {member.fullName}
                      </Link>
                    ) : (
                      member.fullName
                    )}
                    {!member.connected && <small className="font-sans">Disconnected</small>}
                  </td>
                  <td className="font-mono">{member.tasks}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          <section className="flex flex-col gap-4">
            <SearchInput
              className="max-w-sm"
              placeholder="Search Tasks"
              aria-label="Search Tasks"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <DataTable>
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">Repository</th>
                  <th scope="col" className="hidden sm:table-cell">
                    Difficulty
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((task) => (
                  <tr key={`${task.runId}/${task.taskId}`}>
                    <td className="font-mono text-sm wrap-anywhere">
                      {task.repository ? (
                        <Link className="hover:underline" to={taskPath(task.repository, task)}>
                          {task.taskId}
                        </Link>
                      ) : (
                        task.taskId
                      )}
                    </td>
                    <td className="font-mono text-sm text-muted-foreground">{task.repository}</td>
                    <td className="hidden sm:table-cell">
                      {task.difficulty && <DifficultyStamp difficulty={task.difficulty} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
            {shown.length === 0 && <p className="text-sm text-muted-foreground">No tasks match.</p>}
          </section>
        </div>
      )}
    </PageContent>
  );
}
