# Operator Maintenance

These are manual, one-off repair programs, not API or worker entrypoints. They live outside `src/` and are bundled into `dist/maintenance/` by `bun run build:server`, so operators can run them with Node in the API or worker image (which does not include the TypeScript sources).

All commands default to a dry run. Inspect the report before passing `--apply`:

```sh
node dist/maintenance/recompute-cost.js <repoId> <evaluationId> [--apply] [--auth=codex-login|api-key]
node dist/maintenance/reprice-vendor-rates.js <repoId> <evaluationId> [--apply]
node dist/maintenance/reprice-dari-router.js <repoId> <evaluationId> [--apply]
node dist/maintenance/reprice-jev-router.js <repoId> <evaluationId> [--apply]
node dist/maintenance/backfill-agent-timeouts.js <repoId>... [--apply] [--auth=codex-login|api-key]
node dist/maintenance/records-migration.js [--apply]
```

## Jev Router Pricing

New Pi trials preserve `solver/openrouter-generation-ids.json` before transcript truncation.
An optional, owner-supplied OpenRouter management key can be added to the workspace's
OpenRouter credential (UI or credential API). It is sealed with the inference key and stays
server-side, never in Harbor or a solver. No worker-wide management key is used.

Pricing discovers generations in exact proven sessions, joins children to direct request IDs,
and requires settled, nontruncated analytics and complete supported worker/advisor groups.
Full-precision generation records supply the price, not rounded analytics usage. An outer
zero wrapper is not a free request. BYOK provider costs are included separately from OpenRouter
credits. `solver/openrouter-billing.json` preserves the generation-level evidence.

`reprice-jev-router` uses the finished run's owner-scoped inference and management credential,
loaded with `SELFBENCH_DATABASE_URL` and `SELFBENCH_EVAL_CREDENTIAL_KEY`, plus artifact settings.
It defaults to a dry run; `--apply` saves evidence and appends a snapshot only for fully
reconciled trials. Missing access or incomplete historical logs leave existing trials unchanged.
Replacing a credential affects new comparisons, not the credentials of historical runs.
No invoice or billing ledger is modified.

## Dari Router Pricing

New Pi evaluations of `openai/dari/routing` at `https://routing.dari.dev` automatically
look up authenticated per-request model reference costs when each trial finishes.
The worker retries delayed telemetry for about 30 seconds and saves a compact
`solver/dari-request-ids.json` artifact for later retries even if the transcript is
truncated. Missing records, unknown prices, or incomplete streams leave cost unavailable,
not zero. These estimates exclude sandbox and selector infrastructure and are not cash
charges for subscription-backed requests.

Deploy Dari's `/v1/request-costs` endpoint (control plane first, routing runtime second)
before the SelfBench worker. No new SelfBench secrets are required: it uses the custom
endpoint's existing API key, and Dari scopes returned records to that exact key.

`reprice-dari-router` retries pricing for finished runs only. It requires the deployment's
artifact settings, `SELFBENCH_DATABASE_URL`, and `SELFBENCH_EVAL_CREDENTIAL_KEY` to load the
run's existing custom key. It defaults to a dry run and appends a snapshot with `--apply`.
Historical runs without the compact manifest can only be repriced from complete saved
Pi streams; truncated streams are intentionally skipped. It does not estimate a whole
trial's cost by expanding conversations. `recompute-cost` preserves router-priced trials.

The evaluation tools use the deployment's artifact-store settings and optionally `SELFBENCH_DATABASE_URL` to resolve historical credential sign-in types. The records migration requires `SELFBENCH_DATABASE_URL` and `SELFBENCH_EVAL_CREDENTIAL_KEY`; stop the API and worker and back up the database before applying it. See each program's header for its scope and safety constraints. Do not run these as part of a deployment or routine evaluation.
