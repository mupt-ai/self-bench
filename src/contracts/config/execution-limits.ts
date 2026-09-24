/** Dependency-free limits shared by server orchestration and the hosted UI. */
export const MAX_HARBOR_CONCURRENCY = 10;
export const MAX_CONCURRENT_CANDIDATE_WORKFLOWS = 150;
export const MAX_CANDIDATES_PER_RUN = 300;
export const MAX_DISCOVERY_SHARDS = 8;
export const DISCOVERY_POOL_MULTIPLIER = 1.5;

/** Batch reconciler: batches swept at once, each holding one pooled DB connection. */
export const BATCH_SWEEP_CONCURRENCY = 4;
/** Batch reconciler: Temporal RPCs one batch sweep keeps in flight. */
export const BATCH_RPC_CONCURRENCY = 8;
/** Batch reconciler: a running workflow is re-observed at most this often (queries are billed). */
export const BATCH_OBSERVE_INTERVAL_MS = 30_000;
/**
 * Managed workflows running at once across the platform (`SELFBENCH_WORKFLOW_LIMIT`). Each runs
 * at most one sandbox on the managed E2B account, whose plan allows 100.
 */
export const DEFAULT_WORKFLOW_LIMIT = 100;
