// Mounted into the selected application image. Never prints credentials.
import { loadConfig } from '/app/dist/config.js';
const config = loadConfig();
const mode = process.argv[2];
if (mode === 'migrate') {
  const { openDatabase } = await import('/app/dist/db/client.js');
  const database = await openDatabase(process.env.SELFBENCH_DATABASE_URL);
  await database.close();
} else if (mode === 'worker') {
  const hostname = process.argv[3];
  if (!hostname) throw new Error('Expected the new worker hostname');
  const { connectTemporalClient } = await import('/app/dist/temporal/connection.js');
  const connection = await connectTemporalClient(config.temporal);
  try {
    for (const taskQueueType of [1, 2]) {
      const result = await connection.workflowService.describeTaskQueue({
        namespace: config.temporal.namespace,
        taskQueue: { name: config.temporal.taskQueue, kind: 1 }, taskQueueType,
      });
      if (!result.pollers?.some(p => p.identity?.endsWith(`@${hostname}`) &&
          Number(p.lastAccessTime?.seconds) >= Date.now() / 1000 - 60)) {
        throw new Error('New worker is not polling yet');
      }
    }
  } finally { await connection.close(); }
} else if (mode !== 'config') throw new Error('Unknown check');
