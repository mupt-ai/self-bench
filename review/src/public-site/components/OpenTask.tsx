import { lazy, Suspense } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import type { PublicRelease } from "../contract";
import { loadTaskViewer, type OpenedTask } from "./TaskList";

const TaskViewer = lazy(loadTaskViewer);

/**
 * The task the address names (`?task=<id>`), in the task viewer over the page. Opened from the
 * list, closing goes back to it; opened from a link, closing takes the task out of the address.
 */
export function OpenTask({ release }: { release: PublicRelease }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const taskId = params.get("task");
  if (!taskId) return null;
  const opened = (location.state as Partial<OpenedTask> | null)?.fromList === true;
  return (
    <Suspense fallback={null}>
      <TaskViewer
        release={release}
        taskId={taskId}
        onClose={() =>
          opened
            ? navigate(-1)
            : navigate({ search: "" }, { replace: true, preventScrollReset: true })
        }
        onSwitch={(next) =>
          navigate(
            { search: `?task=${encodeURIComponent(next)}` },
            { replace: true, state: location.state, preventScrollReset: true },
          )
        }
      />
    </Suspense>
  );
}
