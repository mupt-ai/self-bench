import { ChevronRight, Plus } from "lucide-react";
import React from "react";
import { Link, useParams } from "react-router";
import { formatAgo } from "../api";
import { cn } from "../primitives/cn";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { taskPath } from "../task/review-queue";
import { StateStamp } from "../task/state";
import { Button, DataTable, EmptyState, Notice, PageContent, PageHeader } from "../ui";
import { useGenerationSettings } from "../useGenerationSettings";
import { ChangesSummary } from "./ChangesSummary";
import { EnvironmentDialog } from "./EnvironmentDialog";
import {
  buildEnvironment,
  deleteEnvironment,
  type EnvironmentItem,
  type EnvironmentTaskItem,
  getEnvironment,
  listEnvironments,
} from "./environment-api";

/** The tasks a build could not start, each with why; null when every one started. */
const notStarted = (failures?: string[]) =>
  failures?.length
    ? `${failures.length} ${failures.length === 1 ? "task" : "tasks"} did not start: ${failures.join("; ")}`
    : null;

const coverage = ({ tasks }: EnvironmentItem) =>
  [
    `${tasks.ready} of ${tasks.total} ready`,
    ...(tasks.checking ? [`${tasks.checking} checking`] : []),
    ...(tasks.failed ? [`${tasks.failed} failed`] : []),
  ].join(" · ");

/**
 * A repository's environments: changes to every approved task's files, such as no AGENTS.md or a
 * framework build, each task built and checked once. A run condition on the Run page names one to
 * run every task as it built them, beside the tasks as they are.
 */
export function EnvironmentsPage() {
  const { org } = useOrg();
  const { owner = "", name = "" } = useParams();
  const fullName = `${owner}/${name}`;
  useDocumentTitle(`Environments · ${fullName} · SelfBench`);
  const [environments, setEnvironments] = React.useState<EnvironmentItem[]>();
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [open, setOpen] = React.useState<number | null>(null);
  const [refresh, setRefresh] = React.useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` reloads after a change.
  React.useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const found = await listEnvironments(org.login, fullName);
        if (stopped) return;
        setEnvironments(found);
        setError(null);
        // Builds settle on their own; follow them while any task is still being checked.
        if (found.some((environment) => environment.tasks.checking > 0))
          timer = setTimeout(() => void load(), 5_000);
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [org.login, fullName, refresh]);

  const changed = () => setRefresh((count) => count + 1);
  return (
    <PageContent>
      <PageHeader
        className="mb-6"
        title="Environments"
        description="Change every task's files once, then compare runs with and without the change."
      >
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" />
          New Environment
        </Button>
      </PageHeader>
      {error && <Notice className="mb-5">{error}</Notice>}
      {!environments ? (
        !error && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading environments…
          </p>
        )
      ) : environments.length === 0 ? (
        <EmptyState title="No Environments Yet">
          Remove AGENTS.md, add a docs block, or swap a package build for every approved task. Then
          pick it as a condition on the Run page.
        </EmptyState>
      ) : (
        <DataTable>
          <thead>
            <tr>
              <th className="w-8" aria-label="Details" />
              <th>Environment</th>
              <th>Tasks</th>
              <th className="text-right">Created</th>
            </tr>
          </thead>
          <tbody>
            {environments.map((environment) => (
              <EnvironmentRow
                key={environment.id}
                org={org.login}
                fullName={fullName}
                environment={environment}
                open={open === environment.id}
                onToggle={() => setOpen(open === environment.id ? null : environment.id)}
                onChanged={changed}
              />
            ))}
          </tbody>
        </DataTable>
      )}
      {creating && (
        <EnvironmentDialog
          org={org.login}
          fullName={fullName}
          onClose={() => setCreating(false)}
          onCreated={({ environment, failures }) => {
            setCreating(false);
            setOpen(environment.id);
            setError(notStarted(failures));
            changed();
          }}
        />
      )}
    </PageContent>
  );
}

function EnvironmentRow({
  org,
  fullName,
  environment,
  open,
  onToggle,
  onChanged,
}: {
  org: string;
  fullName: string;
  environment: EnvironmentItem;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  return (
    <>
      <tr className="cursor-pointer" onClick={onToggle}>
        <td>
          <ChevronRight
            aria-hidden="true"
            className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")}
          />
        </td>
        <td>
          <span className="block font-semibold">{environment.name}</span>
          <span className="mt-1 block text-sm">
            <ChangesSummary {...(environment.changes ? { changes: environment.changes } : {})} />
          </span>
        </td>
        <td className="whitespace-nowrap">{coverage(environment)}</td>
        <td className="text-right whitespace-nowrap text-muted-foreground">
          {[environment.createdBy, formatAgo(environment.createdAt)].filter(Boolean).join(" · ")}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} className="bg-background">
            <EnvironmentDetail
              org={org}
              fullName={fullName}
              environment={environment}
              onChanged={onChanged}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/** Each task's check in one environment, and building the tasks it lacks or deleting it. */
function EnvironmentDetail({
  org,
  fullName,
  environment,
  onChanged,
}: {
  org: string;
  fullName: string;
  environment: EnvironmentItem;
  onChanged: () => void;
}) {
  const [tasks, setTasks] = React.useState<EnvironmentTaskItem[]>();
  const [busy, setBusy] = React.useState<"build" | "delete" | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const { id, tasks: counts } = environment;
  const { settings, valid } = useGenerationSettings(org, fullName);

  // biome-ignore lint/correctness/useExhaustiveDependencies: counts change as checks settle.
  React.useEffect(() => {
    let stopped = false;
    getEnvironment(org, fullName, id).then(
      (found) => {
        if (!stopped) setTasks(found.tasks);
      },
      (cause) => {
        if (!stopped) setNotice(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      stopped = true;
    };
  }, [org, fullName, id, counts.ready, counts.checking, counts.failed]);

  const act = async (action: "build" | "delete") => {
    setBusy(action);
    setNotice(null);
    try {
      // Builds with the generation settings last chosen for this repository, as New Environment did.
      if (action === "build") {
        const { failures } = await buildEnvironment(
          org,
          fullName,
          id,
          valid ? settings : undefined,
        );
        setNotice(notStarted(failures));
      } else await deleteEnvironment(org, fullName, id);
      onChanged();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  const unfinished = (tasks ?? []).filter((task) => task.state !== "accepted");
  return (
    <div className="grid gap-4 py-2">
      {!tasks ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading tasks…
        </p>
      ) : unfinished.length === 0 ? (
        <p className="text-sm text-muted-foreground">Every built task is ready to run.</p>
      ) : (
        <ul className="grid gap-3">
          {unfinished.map((task) => (
            <li key={task.runId} className="grid gap-1">
              <span className="flex flex-wrap items-center gap-3">
                <Link
                  className="font-mono text-sm hover:underline"
                  to={taskPath(fullName, task.task)}
                  onClick={(event) => event.stopPropagation()}
                >
                  {task.task.taskId}
                </Link>
                <StateStamp state={task.state} />
              </span>
              {task.reasonSummary && (
                <span className="text-sm text-muted-foreground wrap-anywhere">
                  {task.reasonSummary}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice && <Notice>{notice}</Notice>}
      <div className="flex flex-wrap gap-2">
        {environment.changes && (
          <Button disabled={busy !== null} onClick={() => void act("build")}>
            {busy === "build" ? "Starting…" : "Build Missing Tasks"}
          </Button>
        )}
        <Button variant="ghost" disabled={busy !== null} onClick={() => void act("delete")}>
          {busy === "delete" ? "Deleting…" : "Delete Environment"}
        </Button>
      </div>
    </div>
  );
}
