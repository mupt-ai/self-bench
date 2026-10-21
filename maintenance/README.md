# Operator Maintenance

These are manual, one-off repair programs, not API or worker entrypoints. They live outside `src/` and are bundled into `dist/maintenance/` by `bun run build:server`, so operators can run them with Node in the API or worker image (which does not include the TypeScript sources).

All commands default to a dry run. Inspect the report before passing `--apply`:

```sh
node dist/maintenance/recompute-cost.js <repoId> <evaluationId> [--apply] [--auth=codex-login|api-key]
node dist/maintenance/reprice-vendor-rates.js <repoId> <evaluationId> [--apply]
node dist/maintenance/reprice-dari-router.js <repoId> <evaluationId> [--apply]
node dist/maintenance/reprice-openrouter.js <repoId> <evaluationId> [--apply]
node dist/maintenance/backfill-timeouts.js <repoId | benchmark:<id>>... [--apply] [--auth=codex-login|api-key]
node dist/maintenance/records-migration.js [--apply]
node dist/maintenance/backfill-execution-bundles.js <repoId>... [--apply]
```

## Historical Task Execution Bundles

The worker exports a task's verified images once a person approves it, and deletes them once a
person rejects or deletes it (`selfBenchTaskImagesWorkflow`, started by the review routes).
`backfill-execution-bundles` applies the same rule to existing tasks. For each task with
recorded provider images it:

- exports a human-approved task's original verified E2B templates, Modal images, Daytona
  snapshots or Vercel images, then publishes a small `execution-task.tar.gz` with pinned `FROM`
  lines instead of repository archives (already exported images are reused);
- returns a rejected or deleted task to its compiled bundle and deletes its exported images,
  unless a saved comparison or release names one of their digests.

Tasks awaiting review, or with no recorded images, are left alone and not reported. It
resolves the original verification account from saved generation settings, without needing
historical model access. Inaccessible provider images fail without rebuilding a different
environment or changing the task row. A removal deletes its images before switching the row, so a
failed deletion leaves the row naming them and a rerun deletes them again.

Run in the worker environment with artifact settings, `SELFBENCH_DATABASE_URL`,
`SELFBENCH_EVAL_CREDENTIAL_KEY`, `SELFBENCH_TASK_IMAGE_REPOSITORY`, registry push permission,
and managed provider keys where applicable. Dry runs only list planned changes; `--apply`
starts provider sandboxes and uploads images, which can incur provider/storage costs.
The task's bundle and image fields switch only after both images and the new bundle exist,
with a concurrent-change guard (bundle, images, review and deletion must all be unchanged).
Removal needs `roles/artifactregistry.repoAdmin` on the task image repository. Original bundles, frozen comparisons and published releases
remain unchanged. New evaluations and releases use the updated task row. Rerunning skips
completed tasks; failed exports leave the original task runnable.

## OpenRouter Pricing

New Pi trials preserve `solver/openrouter-generation-ids.json` before transcript truncation.
An optional, owner-supplied OpenRouter management key can be added to the workspace's
OpenRouter credential (UI or credential API). It is sealed with the inference key and stays
server-side, never in Harbor or a solver. No worker-wide management key is used.

Pricing discovers generations in exact proven sessions, joins children to direct request IDs,
and requires nontruncated analytics with two identical valid snapshots after an indexing delay.
No model identity or child-count assumptions are used. Direct requests need only the inference
key; routed requests require management access. Positive parent/child charges are rejected as
ambiguous rather than double-counted. Stable snapshots reduce indexing races but are not a
provider guarantee that the ledger is final.
Full-precision generation records supply the price, not rounded analytics usage. An outer
zero wrapper is not a free request. BYOK provider costs are included separately from OpenRouter
credits. `solver/openrouter-billing.json` preserves the generation-level evidence.

`reprice-openrouter` uses the finished run's owner-scoped inference credential and optional
management key,
loaded with `SELFBENCH_DATABASE_URL` and `SELFBENCH_EVAL_CREDENTIAL_KEY`, plus artifact settings.
It defaults to a dry run; `--apply` saves evidence and appends a snapshot only for fully
reconciled trials. Missing access or incomplete historical logs leave existing trials unchanged.
Replacing a credential affects new comparisons, not the credentials of historical runs.
No invoice or billing ledger is modified.

## Dari Router Pricing

New Pi evaluations of `openai/dari/routing` at `https://routing.dari.dev` consume
Dari's OpenRouter-compatible `usage.cost` directly from each HTTP response. The Dari Pi
adapter saves compact prices in `solver/dari-billing.jsonl`, independently of the transcript,
including priced errors and retries. Missing or unknown response prices preserve unrelated known
prices as an explicitly incomplete subtotal. With no known prices, cost remains unavailable. These reference costs exclude sandbox and selector infrastructure
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
beginning of saved Codex trajectories, and labels these recovered amounts incomplete. Unrecoverable
amounts remain unknown. Active runs are skipped; their workers must not race a maintenance write.
Public task selection and scores stay unchanged, but incomplete settings leave the cost frontier.
Deploy incomplete-cost display support first, inspect the dry-run report, and run during a quiet
maintenance window. The program needs artifact settings and `SELFBENCH_DATABASE_URL`.

The evaluation tools use the deployment's artifact-store settings and optionally `SELFBENCH_DATABASE_URL` to resolve historical credential sign-in types. The records migration requires `SELFBENCH_DATABASE_URL` and `SELFBENCH_EVAL_CREDENTIAL_KEY`; stop the API and worker and back up the database before applying it. See each program's header for its scope and safety constraints. Do not run these as part of a deployment or routine evaluation.
