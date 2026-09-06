import React from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Button, buttonStyles, DataTable, Input, PageContent, PageHeader } from "../ui";
import { type EvaluationOptions, evaluationRequest, evaluationUrl } from "./api";

export function DatasetPage() {
  const { org } = useOrg();
  const { owner = "", name = "" } = useParams();
  const repo = `${owner}/${name}`;
  const url = evaluationUrl(org.login, repo);
  const [options, setOptions] = React.useState<EvaluationOptions>();
  const [selected, setSelected] = React.useState<string[]>([]);
  const [query, setQuery] = React.useState("");
  const [error, setError] = React.useState("");
  const navigate = useNavigate();
  useDocumentTitle(`Dataset · ${repo}`);
  React.useEffect(() => {
    let disposed = false;
    setOptions(undefined);
    setSelected([]);
    setError("");
    evaluationRequest<EvaluationOptions>(`${url}/options`).then(
      (value) => {
        if (disposed) return;
        setOptions(value);
        if (value.tasks.length <= 10)
          setSelected(value.tasks.map((task) => `${task.runId}/${task.taskId}`));
      },
      (cause: Error) => {
        if (!disposed) setError(cause.message);
      },
    );
    return () => {
      disposed = true;
    };
  }, [url]);
  const tasks = options?.tasks ?? [];
  const visible = tasks.filter((task) => task.taskId.toLowerCase().includes(query.toLowerCase()));
  return (
    <PageContent>
      <PageHeader
        title="Dataset"
        description={
          <>
            {tasks.length} approved {tasks.length === 1 ? "task" : "tasks"} · {selected.length}{" "}
            selected
          </>
        }
      >
        <Button
          type="button"
          variant="primary"
          disabled={!selected.length}
          onClick={() =>
            void navigate(
              `/repos/${repo}/run?tasks=${encodeURIComponent(JSON.stringify(tasks.filter((task) => selected.includes(`${task.runId}/${task.taskId}`)).map(({ runId, taskId }) => ({ runId, taskId }))))}`,
            )
          }
        >
          Run
        </Button>
      </PageHeader>
      {error && (
        <p className="my-4 font-mono text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      {!options && !error && <p role="status">Loading dataset…</p>}
      {options && !tasks.length && (
        <div className="border border-line bg-surface p-4 sm:p-6 [&_p]:mt-2 [&_p]:text-[13px] [&_p]:text-muted">
          <h2>No tasks in your dataset yet</h2>
          <p>Review your tasks to get them ready to run.</p>
          <Link className={buttonStyles.secondary} to={`/repos/${repo}`}>
            Review tasks
          </Link>
        </div>
      )}
      {tasks.length > 0 && (
        <>
          <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-5 [&_label]:flex [&_label]:items-center [&_label]:gap-3 [&_label]:font-mono [&_label]:text-xs [&_label]:text-muted">
            <label>
              <input
                className="size-4 shrink-0 accent-mint"
                type="checkbox"
                aria-label="Select all tasks"
                checked={selected.length === tasks.length}
                disabled={tasks.length > 10}
                onChange={(event) =>
                  setSelected(
                    event.target.checked ? tasks.map((task) => `${task.runId}/${task.taskId}`) : [],
                  )
                }
              />
              {tasks.length > 10 ? "Select up to 10 tasks" : "All tasks"}
            </label>
            <Input
              className="sm:max-w-[320px]"
              type="search"
              placeholder="Find a task…"
              aria-label="Find dataset tasks"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="mt-3 font-mono [&_a]:text-ink [&_a:hover]:text-mint [&_button]:text-ink [&_button:hover]:text-mint">
            <DataTable>
              <thead>
                <tr>
                  <th className="w-12" aria-label="Selection" />
                  <th>Task</th>
                  <th>Difficulty</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((task) => {
                  const key = `${task.runId}/${task.taskId}`;
                  return (
                    <tr key={key}>
                      <td>
                        <input
                          className="size-4 shrink-0 accent-mint"
                          type="checkbox"
                          aria-label={`Select ${task.taskId}`}
                          checked={selected.includes(key)}
                          disabled={selected.length >= 10 && !selected.includes(key)}
                          onChange={(event) =>
                            setSelected(
                              event.target.checked
                                ? [...selected, key]
                                : selected.filter((entry) => entry !== key),
                            )
                          }
                        />
                      </td>
                      <td>
                        <Link
                          to={`/repos/${repo}/tasks/${encodeURIComponent(task.runId)}/${encodeURIComponent(task.taskId)}`}
                        >
                          {task.taskId}
                        </Link>
                      </td>
                      <td>{task.difficulty}</td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
            {!visible.length && (
              <p className="mt-2 text-[13px] text-muted">No tasks match your search.</p>
            )}
          </div>
        </>
      )}
    </PageContent>
  );
}
