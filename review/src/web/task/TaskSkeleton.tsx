import { sheetBody, tab, tabList } from "../../components/viewer-ui";
import { Skeleton } from "../LoadingSkeleton";
import { pageGutter } from "../layout";
import { Breadcrumbs } from "../ui";
import { taskTitle } from "./task-title";

/** Reserve the same frame as the loaded task to avoid layout shifts. */
export function TaskSkeleton({ fullName, taskId }: { fullName: string; taskId: string }) {
  return (
    <div
      className="grid h-[calc(100dvh-56px)] min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)]"
      role="status"
      aria-label="Loading Task"
    >
      <header className={`border-b border-border bg-card py-5 ${pageGutter}`}>
        <Breadcrumbs
          items={[
            { label: "Repositories", to: "/" },
            { label: fullName, to: `/repos/${fullName}` },
            { label: "Task" },
          ]}
        />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl leading-7 font-medium wrap-anywhere">{taskTitle({ taskId })}</h1>
          <Skeleton className="h-5 w-20" />
        </div>
      </header>
      <div
        className="grid min-h-0 min-w-0 grid-cols-1 grid-rows-[140px_minmax(0,1fr)] md:grid-cols-[240px_minmax(0,1fr)] md:grid-rows-1"
        aria-hidden="true"
      >
        <aside className="overflow-hidden border-r border-b border-border md:border-b-0">
          <div className="flex h-11 items-center border-b border-border px-4 text-xs tracking-wider text-muted-foreground uppercase">
            Files
          </div>
          <div className="space-y-3 p-4">
            {["first", "second", "third", "fourth"].map((key) => (
              <Skeleton key={key} className="h-3 w-3/4" />
            ))}
          </div>
        </aside>
        <section className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
          <div className={tabList}>
            <span className={tab}>File</span>
            <span className={tab}>Environment</span>
            <span className={tab}>Pipeline</span>
          </div>
          <div className={sheetBody}>
            <div className="space-y-4 border border-border bg-card p-4">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-3/5" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
