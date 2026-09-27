/** A task in a list the reviewer opened, enough to route to it. */
export interface TaskRef {
  readonly runId: string;
  readonly taskId: string;
}

/**
 * The list a task page was opened from, carried in router state: the tasks in the order shown and
 * the URL (filters included) to return to. Reviewing moves through it without reopening the list.
 */
export interface ReviewQueue {
  readonly tasks: readonly TaskRef[];
  readonly back: string;
  readonly backLabel: string;
}

export function taskPath(fullName: string, task: TaskRef): string {
  return `/repos/${fullName}/tasks/${encodeURIComponent(task.runId)}/${encodeURIComponent(task.taskId)}`;
}

export function queueState(
  tasks: readonly TaskRef[],
  back: string,
  backLabel: string,
): { queue: ReviewQueue } {
  return {
    queue: {
      tasks: tasks.map(({ runId, taskId }) => ({ runId, taskId })),
      back,
      backLabel,
    },
  };
}

/** The queue in a location's state, when the page was opened from a list. */
export function readQueue(state: unknown): ReviewQueue | undefined {
  const queue = (state as { queue?: ReviewQueue } | null)?.queue;
  return queue && Array.isArray(queue.tasks) && typeof queue.back === "string" ? queue : undefined;
}

export function queuePosition(
  queue: ReviewQueue,
  current: TaskRef,
): { index: number; previous?: TaskRef; next?: TaskRef } | undefined {
  const index = queue.tasks.findIndex(
    (task) => task.runId === current.runId && task.taskId === current.taskId,
  );
  if (index < 0) return undefined;
  const previous = queue.tasks[index - 1];
  const next = queue.tasks[index + 1];
  return { index, ...(previous ? { previous } : {}), ...(next ? { next } : {}) };
}

/** Whether a keystroke is the reviewer typing rather than a shortcut. */
export function isTyping(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return true;
  const target = event.target as HTMLElement | null;
  return (
    !!target &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}
