import type { ReleasePreview } from "./api";

/**
 * What the ticked settings would release, recomputed in the browser from the coverage the
 * server returned. The server recomputes everything again on Release.
 */
export interface Selection {
  settings: number;
  /** Indexes into the preview's tasks: every task all ticked settings ran. */
  tasks: number[];
  added: { new: number; returning: number };
  /** Tasks of the current release left out: removed from the dataset, or not run by a ticked setting. */
  droppedFromCurrent: number;
}

export function selectionOf(preview: ReleasePreview, ticked: ReadonlySet<string>): Selection {
  const chosen = preview.settings.filter((setting) => ticked.has(setting.key));
  const coverage = new Map(
    preview.settings.map((setting) => [setting.key, new Set(setting.coverage)]),
  );
  const tasks =
    chosen.length === 0
      ? []
      : preview.tasks.flatMap((_, index) =>
          chosen.every((setting) => coverage.get(setting.key)?.has(index)) ? [index] : [],
        );
  const released = tasks.map((index) => preview.tasks[index]);
  const keptFromCurrent = released.filter((task) => task?.status === "released").length;
  const inCurrent = preview.tasks.filter((task) => task.status === "released").length;
  return {
    settings: chosen.length,
    tasks,
    added: {
      new: released.filter((task) => task?.status === "new").length,
      returning: released.filter((task) => task?.status === "returning").length,
    },
    droppedFromCurrent: preview.removed.length + (inCurrent - keptFromCurrent),
  };
}
