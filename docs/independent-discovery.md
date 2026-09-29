# Independent Discovery Shards

New batch submissions are application records, not parent Temporal workflows:

1. Server code fetches up to 500 merged PRs through GitHub GraphQL (creation-time descending, preserving the previous fetch cap). Filtering excludes bots and changes below the existing minimum size. This does not mean the latest 500 by merge time.
2. The server freezes sanitized provenance into deterministic chunks of 25 distinct PRs. All messages for one PR stay together. Empty chunks are not launched.
3. Each chunk is one top-level `selfBenchDiscoveryShardWorkflow`. Its activity consumes that exact chunk rather than repartitioning it. Completion returns candidates and closes that execution.
4. Application reconciliation deduplicates candidates by source PR and persists the candidate plan. Each candidate gets one top-level `selfBenchAuthorWorkflow`, which owns its entire author/reviewer loop.
5. The application aggregates results and builds the export. No Temporal batch coordinator, child launch, parent progress signal, or parent-close policy is used for new batches.

`generation_batches` stores the frozen plan and progress. Reconciliation is a bounded periodic application loop, not an activity holding a generation worker slot. A database row lock serializes updates from API replicas; a replica skips a batch another replica holds. Each five-second tick visits every active batch (a few at a time) and starts or observes all of its items concurrently with a bounded number of Temporal RPCs in flight. The application does not cap how many workflows run: a started workflow's work waits in Temporal's task queues, where worker slots bound it and the Harbor queue's backlog drives the GKE Harbor workers' autoscaling, and a sandbox start the provider refuses at its concurrent-sandbox quota (E2B answers 429) waits in its workflow, retrying after one to eight minutes without holding a worker slot or spending an activity retry. Candidates are planned in the sweep that ends discovery and start in the next, so the plan is durable before any start. A running execution is re-observed at most every 30 seconds, and a failed RPC leaves only its own item for the next tick. Exports run outside the tick so a slow export never stalls other batches. Worker activity concurrency remains an independent deployment setting; sharding does not change it.

The application uses stable workflow IDs and rejects reuse of completed execution IDs. It rechecks an ambiguous start rather than allocating a new ID. Cancel marks a batch before further dispatch; reconciliation requests cancellation of every unsettled workflow, fencing any ID that never started with a no-op tombstone, and waits for terminal execution status. Export completion checks that the batch is still in the exporting phase.

Existing parent/child workflow implementations remain registered only for historical execution compatibility. Existing runs are neither restarted nor rewritten. The new submission routes do not start them.

## Validation Boundary

Local tests cover GraphQL pagination/errors, deterministic partitioning, persisted plans, database rollback, lost-start-response recovery, cancellation without allocation, and aggregation. These are not a substitute for a live Temporal replay/integration test or an actual deployed end-to-end run. This refactor is not deployed by editing local source.

## Repository Execution Boundary

The generation worker dispatches trusted preparation programs to fresh allocations using the selected sandbox provider. Repository clone/fetch/checkout, task compilation and repository snapshot creation run in the compiler sandbox—not on the worker and not in the author's mutable session. Draft packaging, submission unpacking, base-repository coupling scans, and batch archive creation likewise run in preparation sandboxes. The worker transports opaque artifacts and small JSON reports.

Harbor's control client still stages compiled task bundles on the worker before handing them to its chosen environment. That staging is not a repository checkout or test execution; model/test execution and dependency installation run in Harbor-managed environments. This change does not yet eliminate local Harbor bundle staging or all artifact buffering. The local Docker provider remains local containers, not remote capacity. Do not infer an unlimited worker-concurrency budget.

Compiler sandboxes receive only the run's GitHub credential, not model credentials. Other preparation sandboxes receive no workload credentials. Export preserves the exact accepted bundle bytes instead of regenerating tests after verification.

Cancellation before dispatch reserves a no-op Temporal execution under the intended ID. Reject-duplicate start policy prevents a delayed paid start from winning after that reservation; if the real start won first, normal cancellation waits for it to settle.

## Concurrency Trial

The next dev trial is 8 activity slots, after deploying this sandbox-preparation build. Production remains at 1; local Docker defaults remain conservative. A local eight-way compiler/material test completed all jobs in 7.7 seconds with 133 MiB coordinator RSS. This is preparation-path evidence, not a cloud capacity guarantee or an eight-way agent benchmark. An author activity can keep an author sandbox plus a preparation or Harbor sandbox alive concurrently, so reserve provider capacity above the activity limit and measure model throttling, Harbor-client memory, and artifact traffic. Runtime dev configuration must be updated separately after rollout; this PR does not mutate cloud secrets or running workers.
