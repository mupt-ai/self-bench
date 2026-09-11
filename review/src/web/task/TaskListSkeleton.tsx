import { cn } from "../primitives/cn";
import { TaskListHeader } from "./TaskList";
import { taskDetailsLayout, taskRowLayout } from "./task-list-layout";

export function TaskListSkeleton() {
  return (
    <>
      <TaskListHeader />
      <ul
        className="pointer-events-none list-none divide-y divide-border"
        aria-busy="true"
        aria-label="Loading Tasks"
      >
        {[0, 1, 2, 3, 4].map((index) => (
          <li key={index} className={cn(taskRowLayout, "py-3")}>
            <span className="size-4 bg-accent" />
            <div className={taskDetailsLayout}>
              <span className="grid min-w-0 gap-3 py-1">
                <span
                  className={cn(
                    "h-3.5 max-w-72 animate-pulse bg-accent motion-reduce:animate-none",
                    index % 2 ? "w-4/5" : "w-full",
                  )}
                />
                <span className="h-2.5 w-3/5 max-w-48 animate-pulse bg-accent motion-reduce:animate-none" />
              </span>
              <span className="hidden h-3 w-12 bg-accent xl:block" />
              <span className="flex gap-6 md:contents">
                <span className="h-3 w-12 bg-accent" />
                <span className="h-3 w-20 bg-accent" />
              </span>
            </div>
            <span />
          </li>
        ))}
      </ul>
    </>
  );
}
