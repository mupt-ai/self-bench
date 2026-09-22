import type { Database } from "../db/client.js";
import { tasks } from "../db/schema.js";

export async function reserveTaskStart(db: Database, row: typeof tasks.$inferInsert) {
  for (let attempt = 1; ; attempt++) {
    const runId = `${row.runId}${attempt > 1 ? `-a${attempt}` : ""}`;
    const [inserted] = await db
      .insert(tasks)
      .values({
        ...row,
        runId,
        workflowId: `${runId}/candidate/${row.candidateId}`,
      })
      .onConflictDoNothing()
      .returning({ id: tasks.id });
    if (inserted) return inserted.id;
  }
}
