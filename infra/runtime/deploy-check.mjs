// Mounted into the built application container. Never prints credentials.
import { Client } from '/app/node_modules/@temporalio/client/lib/index.js';
import { loadConfig } from '/app/dist/config.js';
import { connectTemporalClient } from '/app/dist/temporal/connection.js';
const config = loadConfig();
const connection = await connectTemporalClient(config.temporal);
try {
  const client = new Client({ connection, namespace: config.temporal.namespace });
  if (process.argv[2] === 'idle') {
    // Dedicated environment namespace; fail closed rather than interrupt billable work.
    const result = await client.workflow.count('ExecutionStatus = "Running"');
    if (result.count !== 0) throw new Error('Active workflows must finish before deploying');
  } else if (process.argv[2] === 'worker') {
    for (const taskQueueType of [1, 2]) {
      const result = await connection.workflowService.describeTaskQueue({
        namespace: config.temporal.namespace,
        taskQueue: { name: config.temporal.taskQueue, kind: 1 }, taskQueueType,
      });
      if (!result.pollers?.some(p => Number(p.lastAccessTime?.seconds) >= Date.now() / 1000 - 60)) {
        throw new Error('No recent worker poller');
      }
    }
  } else throw new Error('Unknown check');
} finally { await connection.close(); }
