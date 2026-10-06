import { currentOf, headOf } from "../db/releases.js";
import type { ReleasePreview } from "./release-build.js";

/** A release row as the Releases tab lists it; private detail stays on the server. */
export interface ReleaseSummary {
  id: string;
  releasedAt: string;
  releasedBy: string;
  withdrawnAt?: string;
  withdrawnBy?: string;
  /** Where its line shows on selfbench.dev, from the site's root. */
  path: string;
  publisher: string;
  tasks: number;
  settings: number;
  /** Whether the tasks were published with it; the release dialog starts from the current one's. */
  tasksPublished: boolean;
  current: boolean;
  head: boolean;
}

/** What the release dialog shows: the preview plus the line's head and current release. */
export interface ReleaseView {
  preview: ReleasePreview;
  head: ReleaseSummary | null;
  current: ReleaseSummary | null;
}

/** A group's view adds the address its line has claimed, or none yet, and one to offer. */
export interface GroupReleaseView extends ReleaseView {
  slug: string | null;
  suggestedSlug: string;
}

/** The Releases tab's list, and where released pages live: null when no results site is set up. */
export interface ReleaseList {
  releases: ReleaseSummary[];
  resultsSiteUrl: string | null;
}

/** What a summary reads from a row: a repository's release or a group's. */
interface SummaryRow {
  readonly id: string;
  readonly releasedAt: string;
  readonly releasedByLogin: string;
  readonly withdrawnAt?: string;
  readonly withdrawnByLogin?: string;
  readonly publisherLogin: string;
  readonly payload: { tasks: number; settings: readonly unknown[]; tasksPublished?: true };
}

/** A row as listed; `path` is where its line shows on selfbench.dev. */
export function summaryOf<Row extends SummaryRow>(
  row: Row,
  rows: readonly Row[],
  path: string,
): ReleaseSummary {
  return {
    id: row.id,
    releasedAt: row.releasedAt,
    releasedBy: row.releasedByLogin,
    ...(row.withdrawnAt ? { withdrawnAt: row.withdrawnAt } : {}),
    ...(row.withdrawnByLogin ? { withdrawnBy: row.withdrawnByLogin } : {}),
    path,
    publisher: row.publisherLogin,
    tasks: row.payload.tasks,
    settings: row.payload.settings.length,
    tasksPublished: row.payload.tasksPublished === true,
    current: currentOf(rows)?.id === row.id,
    head: headOf(rows)?.id === row.id,
  };
}

/** A preview with the head and current release the dialog shows beside it. */
export function viewOf<Row extends SummaryRow>(
  rows: readonly Row[],
  preview: ReleasePreview,
  pathOf: (row: Row) => string,
): ReleaseView {
  const head = headOf(rows);
  const current = currentOf(rows);
  return {
    preview,
    head: head ? summaryOf(head, rows, pathOf(head)) : null,
    current: current ? summaryOf(current, rows, pathOf(current)) : null,
  };
}
