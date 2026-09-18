# Independent Discovery Shards

New batch submissions are application records, not parent Temporal workflows:

1. Server code fetches up to 500 merged PRs through GitHub GraphQL (creation-time descending, preserving the previous fetch cap). Filtering excludes bots and changes below the existing minimum size. This does not mean the latest 500 by merge time.
2. The server freezes sanitized provenance into deterministic chunks of 25 distinct PRs. All messages for one PR stay together. Empty chunks are not launched.
3. Each chunk is one top-level `selfBenchDiscoveryShardWorkflow`. Its activity consumes that exact chunk rather than repartitioning it. Completion returns candidates and closes that execution.
4. Application reconciliation deduplicates candidates by source PR and persists the dispatch plan. Each candidate gets one top-level `selfBenchAuthorWorkflow`, which owns its entire author/reviewer loop.
5. The application aggregates results and builds the export. No Temporal batch coordinator, child launch, parent progress signal, or parent-close policy is used for new batches.

`generation_batches` stores the frozen plan and progress. Reconciliation is a bounded periodic application loop, not an activity holding a generation worker slot. A database row lock serializes updates from API replicas. One execution is observed per sweep. Worker activity concurrency remains an independent deployment setting; sharding does not change it.

The application uses stable workflow IDs and rejects reuse of completed execution IDs. It rechecks an ambiguous start rather than allocating a new ID. Cancel marks a batch before further dispatch; reconciliation requests cancellation of its independent workflows and waits for terminal execution status. Export completion checks that the batch is still in the exporting phase.

Existing parent/child workflow implementations remain registered only for historical execution compatibility. Existing runs are neither restarted nor rewritten. The new submission routes do not start them.

## Validation Boundary

Local tests cover GraphQL pagination/errors, deterministic partitioning, persisted plans, database rollback, lost-start-response recovery, cancellation without allocation, and aggregation. These are not a substitute for a live Temporal replay/integration test or an actual deployed end-to-end run. This refactor is not deployed by editing local source.
