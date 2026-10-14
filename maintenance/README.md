# Operator Maintenance

These are manual, one-off repair programs, not API or worker entrypoints. They live outside `src/` and are bundled into `dist/maintenance/` by `bun run build:server`, so operators can run them with Node in the API or worker image (which does not include the TypeScript sources).

All commands default to a dry run. Inspect the report before passing `--apply`:

```sh
node dist/maintenance/recompute-cost.js <repoId> <evaluationId> [--apply] [--auth=codex-login|api-key]
node dist/maintenance/reprice-vendor-rates.js <repoId> <evaluationId> [--apply]
node dist/maintenance/reprice-dari-router.js <repoId> <evaluationId> [--apply]
node dist/maintenance/reprice-openrouter.js <repoId> <evaluationId> [--apply]
node dist/maintenance/backfill-agent-timeouts.js <repoId>... [--apply] [--auth=codex-login|api-key]
node dist/maintenance/records-migration.js [--apply]
```

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
including priced errors and retries. Missing or unknown response prices leave cost unavailable,
not zero or a partial bill. These reference costs exclude sandbox and selector infrastructure
and are not cash charges for subscription-backed requests. Deploy Dari's response pricing
before the SelfBench adapter.

`reprice-dari-router` can restore costs only when a completed trial already has the compact
`solver/dari-billing.jsonl` response evidence. It requires only the artifact store, defaults to
a dry run and appends a snapshot with `--apply`. Historical trials without that evidence remain
unpriced; it does not query a separate billing ledger or estimate from transcripts.
`recompute-cost` preserves router-priced trials.

The evaluation tools use the deployment's artifact-store settings and optionally `SELFBENCH_DATABASE_URL` to resolve historical credential sign-in types. The records migration requires `SELFBENCH_DATABASE_URL` and `SELFBENCH_EVAL_CREDENTIAL_KEY`; stop the API and worker and back up the database before applying it. See each program's header for its scope and safety constraints. Do not run these as part of a deployment or routine evaluation.
