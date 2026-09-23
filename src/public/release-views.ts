import { currentOf, headOf, type ReleaseRow } from "../db/releases.js";
import type { ReleasePreview } from "./release-build.js";

/** A release row as the Releases tab lists it; private detail stays on the server. */
export interface ReleaseSummary {
  id: string;
  releasedAt: string;
  releasedBy: string;
  withdrawnAt?: string;
  withdrawnBy?: string;
  fullName: string;
  publisher: string;
  tasks: number;
  settings: number;
  current: boolean;
  head: boolean;
}

/** What the release dialog shows: the preview plus the line's head and current release. */
export interface ReleaseView {
  preview: ReleasePreview;
  head: ReleaseSummary | null;
  current: ReleaseSummary | null;
}

/** The Releases tab's list, and where released pages live. */
export interface ReleaseList {
  releases: ReleaseSummary[];
  resultsSiteUrl: string;
}

export function summaryOf(row: ReleaseRow, rows: readonly ReleaseRow[]): ReleaseSummary {
  return {
    id: row.id,
    releasedAt: row.releasedAt,
    releasedBy: row.releasedByLogin,
    ...(row.withdrawnAt ? { withdrawnAt: row.withdrawnAt } : {}),
    ...(row.withdrawnByLogin ? { withdrawnBy: row.withdrawnByLogin } : {}),
    fullName: row.fullName,
    publisher: row.publisherLogin,
    tasks: row.payload.tasks,
    settings: row.payload.settings.length,
    current: currentOf(rows)?.id === row.id,
    head: headOf(rows)?.id === row.id,
  };
}

/** A preview with the head and current release the dialog shows beside it. */
export function viewOf(rows: readonly ReleaseRow[], preview: ReleasePreview): ReleaseView {
  const head = headOf(rows);
  const current = currentOf(rows);
  return {
    preview,
    head: head ? summaryOf(head, rows) : null,
    current: current ? summaryOf(current, rows) : null,
  };
}
