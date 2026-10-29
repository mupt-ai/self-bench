# Operator Maintenance

These are manual, one-off repair programs, not API or worker entrypoints. They live outside `src/` and are bundled into `dist/maintenance/` by `bun run build:server`, so operators can run them with Node in the API or worker image (which does not include the TypeScript sources).

All commands default to a dry run. Inspect the report before passing `--apply`:

```sh
node dist/maintenance/recompute-cost.js <repoId> <evaluationId> [--apply] [--auth=codex-login|api-key]
node dist/maintenance/reprice-dari-router.js <repoId> <evaluationId> [--apply]
node dist/maintenance/backfill-timeouts.js <repoId | benchmark:<id>>... [--apply] [--auth=codex-login|api-key]
node dist/maintenance/records-migration.js [--apply]
node dist/maintenance/compact-task-bundles.js <runId>... | --all [--apply]
```

## Task Images for Older Tasks

Tasks accepted before images were built (and any whose images a rejection removed before they
were approved again) run on their Dockerfiles. `selfBenchTaskImagesBackfillWorkflow` gives them
images on the normal workers, not as a job of its own: each row runs its
`selfBenchTaskImagesWorkflow` (`task-images/<row id>`), which builds the task's compiled images,
runs the smoke, nop and oracle gates on them on the provider and account its run checked it with,
and records them with an execution bundle only if every gate passes. Images that fail are
deleted and the row is left as it was; the gates' outputs land in `rebuild-<time>/` beside the
compiled bundle. Managed runs are refused, since their provider is stamped on the run rather than
saved. Start it with the Temporal CLI, a dry run first:

```sh
temporal workflow start --type selfBenchTaskImagesBackfillWorkflow \
  --task-queue <SELFBENCH_TASK_QUEUE> --workflow-id task-images-backfill/<date> \
  --input '{"repoIds":[25],"dryRun":true}'
```

`dryRun` returns the row IDs it would rebuild; `rowIds` names rows instead, for a pilot;
`concurrency` (default 4) is how many rebuild at once, each holding a slot of its verifying
credential. The result maps each row to its outcome (`rebuilt`, `failed at <gate>`, `skipped`,
`already running`, or the error).

## Converting Tasks Authored as definition.json

Tasks accepted before authors wrote native files (`definition.json` with an environment schema)
still run on what that compiler rendered. `selfBenchTaskConversionBackfillWorkflow` rewrites
each kept one as the native files an author writes today (`src/generation/task/legacy.ts`),
compiles them over the task's own snapshot into `runs/<run>/conversion/<candidate>/<time>/`, and
checks that compile as an image rebuild does. A row takes the new bundle and images, and drops its
definition, only if every gate passes; otherwise it is left as it was. Revisions of a converted
task start from its native files. A task with services, or one whose files fail the submission
check (an empty `test.patch`), is reported `unconvertible` with why, for an author to revise.
Start it like the image backfill, a dry run first:

```sh
temporal workflow start --type selfBenchTaskConversionBackfillWorkflow \
  --task-queue <SELFBENCH_TASK_QUEUE> --workflow-id task-conversion-backfill/<date> \
  --input '{"rowIds":[123],"concurrency":4}'
```

A task from a managed run is checked on the deployment's managed account; where the deployment
offers none, `"managed":{"orgId":3,"credentialId":"<id>"}` names an organization's own saved
Modal or E2B credential to check those tasks on instead. `dryRun`, `rowIds`, `repoIds` and
`concurrency` mean what they do for the image backfill; without
`rowIds` it covers every kept row that still has a definition. The result maps each row to
`rebuilt`, `failed at <gate>`, `unconvertible: <why>`, `skipped`, or the error.

## Task Bundle Compaction

Every compile attempt used to keep its own repository snapshot (`repo.tar.gz`) and a full bundle
(`harbor-task.tar.gz`) holding that snapshot twice more, so one task's retries stored the same
repository dozens of times. When a candidate finishes, the worker now compacts its attempts
(`compactCandidateBundles`):

- each snapshot moves to one shared copy per content, `snapshots/<sha256>.tar.gz`, and the attempt
  keeps a `repo.json` pointer to it (`git archive` of a commit is the same bytes every time);
- each full bundle except the accepted task's goes, once its `gate-task.tar.gz` and snapshot are
  shown to hold exactly its files (paths, modes, contents). Attempts without a gate task (older
  compiles of tasks with services) keep theirs.

Readers of the snapshot (Modal trials, the run viewer) follow the pointer; the viewer and public
downloads already read the gate task. `compact-task-bundles` applies the same to finished
candidates of existing runs. It keeps every bundle an accepted task row (deleted ones included),
saved comparison or release names, and the compiled bundle beside an execution bundle; candidates
without a row or still in progress are skipped. The dry run reports what applying frees.
`--apply` needs the artifact store and `SELFBENCH_DATABASE_URL`, and streams each full bundle it
deletes once. The bucket is versioned: deleted objects stay noncurrent and recoverable for 30
days, when its lifecycle rule removes them, so the storage bill drops a month after a run. A Modal
evaluation running during the backfill may lose its snapshot link and build again on retry.

## Dari Router Pricing

New Pi evaluations of `openai/dari/routing` at `https://routing.dari.dev` consume
Dari's OpenRouter-compatible `usage.cost` directly from each HTTP response. The Dari Pi
adapter saves compact prices in `solver/dari-billing.jsonl`, independently of the transcript,
including priced errors and retries. A request without a price, such as one the agent's time limit
cut off or one refused before it was billed, adds nothing. Without a valid bill, cost remains
unavailable. These reference costs exclude sandbox and selector infrastructure
and are not cash charges for subscription-backed requests. Deploy Dari's response pricing
before the SelfBench adapter.

`reprice-dari-router` can restore costs only when a completed trial already has the compact
`solver/dari-billing.jsonl` response evidence. It requires only the artifact store, defaults to
a dry run and appends a snapshot with `--apply`. Historical trials without that evidence remain
unpriced; it does not query a separate billing ledger or estimate from transcripts.
`recompute-cost` preserves router-priced trials.

## Repair Cost Coverage

`node dist/maintenance/repair-cost-coverage.js` audits saved evaluations and public releases.
With `--apply`, it backs up changed records under `maintenance/cost-coverage/<timestamp>/` in the
artifact store before appending evaluation snapshots or updating release accounting. It preserves
complete prices, recovers Dari response subtotals and complete request-metric objects from the
beginning of saved Codex trajectories. Unrecoverable amounts remain unknown, and a setting's cost
per task is the mean of its priced tasks. Active runs are skipped; their workers must not race a
maintenance write. Public task selection and scores stay unchanged. Inspect the dry-run report, and
run during a quiet maintenance window. The program needs artifact settings and `SELFBENCH_DATABASE_URL`.

The evaluation tools use the deployment's artifact-store settings and optionally `SELFBENCH_DATABASE_URL` to resolve historical credential sign-in types. The records migration requires `SELFBENCH_DATABASE_URL` and `SELFBENCH_EVAL_CREDENTIAL_KEY`; stop the API and worker and back up the database before applying it. See each program's header for its scope and safety constraints. Do not run these as part of a deployment or routine evaluation.
