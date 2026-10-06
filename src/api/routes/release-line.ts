import type { ServerResponse } from "node:http";
import { z } from "zod";
import { currentOf, headOf, ReleaseConflict } from "../../db/releases.js";
import { ReleaseRefused } from "../../public/release-build.js";
import { type ReleaseView, summaryOf } from "../../public/release-views.js";
import { sendJson } from "../http.js";

/** What a release request names: the ticked settings, and the preview the releaser confirmed. */
export const releaseRequest = z
  .object({
    settings: z.array(z.string().min(1).max(4096)).min(1).max(500),
    /** The line's head as the releaser saw it; null for a first release. */
    head: z.uuid().nullable(),
    /** The fingerprint of the preview the releaser confirmed. */
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    /** Publish the tasks too, for anyone to browse and download on selfbench.dev. */
    publishTasks: z.boolean().optional(),
  })
  .strict();
export type ReleaseRequest = z.infer<typeof releaseRequest>;

type LineRow = Parameters<typeof summaryOf>[0] & { readonly hash: string };

/**
 * One release line, a repository's or a group's: how to read it, check it can be released, build
 * a release, and save one. `publish` runs the same steps on either.
 */
export interface Line<Row extends LineRow, Inputs, Checked, Request extends ReleaseRequest> {
  list(): Promise<Row[]>;
  /** What the rule reads now, and the preview it gives. */
  gather(rows: readonly Row[]): Promise<{ inputs: Inputs; view: ReleaseView }>;
  /** Where the row's line shows on selfbench.dev. */
  pathOf(row: Row): string;
  /** What must hold to release now, checked live; answers and gives undefined when it does not. */
  check(response: ServerResponse, request: Request): Promise<Checked | undefined>;
  /** Throws `ReleaseRefused` when the ticked settings cannot be released. */
  build(
    inputs: Inputs,
    checked: Checked,
    request: Request,
  ): { hash: string; save(head?: string): Promise<Row> };
  /** Told after a release is saved. */
  published(row: Row): void;
}

/** Writes a release for the settings the request names, or answers why not. */
export async function publish<Row extends LineRow, Inputs, Checked, Request extends ReleaseRequest>(
  line: Line<Row, Inputs, Checked, Request>,
  rows: readonly Row[],
  body: Request,
  response: ServerResponse,
): Promise<void> {
  const { inputs, view: fresh } = await line.gather(rows);
  const head = headOf(rows);
  // Someone released, or withdrew and released, since this person looked.
  if (body.head !== (head?.id ?? null)) {
    sendJson(response, 409, {
      error: head
        ? `${head.releasedByLogin} released at ${head.releasedAt}. Review the refreshed preview.`
        : "The release you saw is gone. Review the refreshed preview.",
      ...fresh,
    });
    return;
  }
  // Results, tasks, or the current release changed since the preview was taken.
  if (body.fingerprint !== fresh.preview.fingerprint) {
    sendJson(response, 409, {
      error:
        "Results, tasks, or the current release changed since you opened this. Review the refreshed preview.",
      ...fresh,
    });
    return;
  }
  const checked = await line.check(response, body);
  if (!checked) return;
  let built: ReturnType<typeof line.build>;
  try {
    built = line.build(inputs, checked, body);
  } catch (error) {
    if (!(error instanceof ReleaseRefused)) throw error;
    sendJson(response, 400, { error: error.message });
    return;
  }
  // Unchanged results write no row: a double click or a retry. The line is read again after
  // the live checks, so a withdrawal meanwhile is not mistaken for "still public".
  const now = await line.list();
  const current = currentOf(now);
  if (current && current.hash === built.hash && headOf(now)?.id === head?.id) {
    sendJson(response, 200, {
      unchanged: true,
      release: summaryOf(current, now, line.pathOf(current)),
    });
    return;
  }
  try {
    const row = await built.save(head?.id);
    line.published(row);
    const after = await line.list();
    sendJson(response, 201, { release: summaryOf(row, after, line.pathOf(row)) });
  } catch (error) {
    if (error instanceof ReleaseRefused) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    if (!(error instanceof ReleaseConflict)) throw error;
    sendJson(response, 409, {
      error: "Someone else released first. Review the refreshed preview.",
      ...(await line.gather(await line.list())).view,
    });
  }
}
