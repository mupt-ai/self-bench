import { lazy, Suspense } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import type { PublicRelease } from "../contract";
import { loadTraceViewer } from "./ResultsGrid";
import type { OpenedTask } from "./TaskList";

const TraceViewer = lazy(loadTraceViewer);

/**
 * The trace the address names (`?trace=<task>&setting=<id>`), in the trace viewer over the page.
 * Opened from the grid, closing goes back to it; opened from a link, closing takes the trace out
 * of the address. View Task swaps it for the task viewer in the same place in history.
 */
export function OpenTrace({ release }: { release: PublicRelease }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const taskId = params.get("trace");
  const settingId = params.get("setting");
  if (!taskId || !settingId) return null;
  const opened = (location.state as Partial<OpenedTask> | null)?.fromList === true;
  return (
    <Suspense fallback={null}>
      <TraceViewer
        release={release}
        taskId={taskId}
        settingId={settingId}
        onClose={() =>
          opened
            ? navigate(-1)
            : navigate({ search: "" }, { replace: true, preventScrollReset: true })
        }
        onOpenTask={() =>
          navigate(
            { search: `?task=${encodeURIComponent(taskId)}` },
            { replace: true, state: location.state, preventScrollReset: true },
          )
        }
      />
    </Suspense>
  );
}
