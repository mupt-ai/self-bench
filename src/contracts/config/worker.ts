import { z } from "zod";

/**
 * Which task queues a worker process polls: everything (local and single-container deployments),
 * only the workflow queue, or only the Harbor queue, so the two can scale apart.
 */
type WorkerRole = "all" | "workflows" | "harbor";

export interface WorkerProcessSettings {
  readonly role: WorkerRole;
  /** How long a stopping worker lets in-flight activities finish before cancelling them. */
  readonly shutdownGraceMs: number;
}

const schema = z.object({
  SELFBENCH_WORKER_ROLE: z.enum(["all", "workflows", "harbor"]).default("all"),
  SELFBENCH_WORKER_SHUTDOWN_GRACE_SECONDS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(0).default(0),
  ),
});

export function workerProcessSettings(environment: NodeJS.ProcessEnv): WorkerProcessSettings {
  const value = schema.parse(environment);
  return {
    role: value.SELFBENCH_WORKER_ROLE,
    shutdownGraceMs: value.SELFBENCH_WORKER_SHUTDOWN_GRACE_SECONDS * 1000,
  };
}
