import type { TaskImages } from "../../src/contracts/index.js";
import type { Database } from "../../src/db/client.js";
import { tasks } from "../../src/db/schema.js";
import type { PipelineStatus } from "../../src/db/tasks.js";

/** A task row as a finished (or running) candidate workflow would have left it. */
export interface SeededTask {
  readonly repoId: number;
  readonly runId: string;
  readonly candidateId: string;
  readonly taskId: string;
  readonly sourcePr?: number;
  readonly sourceUrl?: string;
  /** Medium unless named. */
  readonly difficulty?: "easy" | "medium" | "hard";
  readonly pipelineStatus: PipelineStatus;
  /** The status itself unless named, as a settled workflow leaves an accepted task. */
  readonly stage?: string;
  readonly round?: number;
  readonly reason?: string;
  readonly bundleKey?: string;
  readonly definition?: Record<string, unknown>;
  readonly images?: TaskImages;
  readonly workflowId?: string;
}

/** Writes task rows straight into the table, as fixtures for what workflows write. */
export async function seedTasks(db: Database, rows: readonly SeededTask[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(tasks).values(
    rows.map((row) => ({
      ...row,
      difficulty: row.difficulty ?? "medium",
      stage: row.stage ?? row.pipelineStatus,
    })),
  );
}
