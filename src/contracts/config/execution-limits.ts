/** Dependency-free limits shared by server orchestration and the hosted UI. */
export const MAX_HARBOR_CONCURRENCY = 10;
/**
 * Trial workflows one evaluation keeps started at once. Not a product limit: Temporal refuses a
 * workflow more than 2,000 pending child workflows, so a larger evaluation starts the rest as
 * earlier trials finish. Harbor worker capacity is what bounds trials actually running.
 */
export const MAX_PENDING_TRIAL_WORKFLOWS = 1000;
export const MAX_CANDIDATES_PER_RUN = 300;
/**
 * A new ChatGPT sign-in's limit on sandboxes calling it at once (`maxSandboxes`), unless one is
 * given. A ChatGPT subscription rate-limits far below an API key: with every trial of a 113-task
 * evaluation calling one at once, Codex gave up on most of them after its own retries (429).
 */
export const CHATGPT_SIGN_IN_MAX_SANDBOXES = 50;
export const MAX_DISCOVERY_SHARDS = 8;
export const DISCOVERY_POOL_MULTIPLIER = 1.5;
/** Longest batch focus, the requester's description of which PRs discovery picks. */
export const MAX_FOCUS_LENGTH = 1000;

/** Batch status: Temporal RPCs one read of a running batch keeps in flight. */
export const BATCH_RPC_CONCURRENCY = 8;
