/** Dependency-free limits shared by server orchestration and the hosted UI. */
export const MAX_HARBOR_CONCURRENCY = 10;
/**
 * Trial workflows one evaluation keeps started at once. Not a product limit: Temporal refuses a
 * workflow more than 2,000 pending child workflows, so a larger evaluation starts the rest as
 * earlier trials finish. Harbor worker capacity is what bounds trials actually running.
 */
export const MAX_PENDING_TRIAL_WORKFLOWS = 1000;
export const MAX_CANDIDATES_PER_RUN = 300;
export const MAX_DISCOVERY_SHARDS = 8;
export const DISCOVERY_POOL_MULTIPLIER = 1.5;

/** Batch reconciler: batches swept at once, each holding one pooled DB connection. */
export const BATCH_SWEEP_CONCURRENCY = 4;
/** Batch reconciler: Temporal RPCs one batch sweep keeps in flight. */
export const BATCH_RPC_CONCURRENCY = 8;
/** Batch reconciler: a running workflow is re-observed at most this often (queries are billed). */
export const BATCH_OBSERVE_INTERVAL_MS = 30_000;
