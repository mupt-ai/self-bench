# Operator Maintenance

These are manual, one-off repair programs, not API or worker entrypoints. They live outside `src/` and are bundled into `dist/maintenance/` by `bun run build:server`, so operators can run them with Node in the API or worker image (which does not include the TypeScript sources).

All commands default to a dry run. Inspect the report before passing `--apply`:

```sh
node dist/maintenance/recompute-cost.js <repoId> <evaluationId> [--apply] [--auth=codex-login|api-key]
node dist/maintenance/backfill-agent-timeouts.js <repoId>... [--apply] [--auth=codex-login|api-key]
node dist/maintenance/records-migration.js [--apply]
```

The two evaluation tools use the deployment's artifact-store settings and optionally `SELFBENCH_DATABASE_URL` to resolve historical credential sign-in types. The records migration requires `SELFBENCH_DATABASE_URL` and `SELFBENCH_EVAL_CREDENTIAL_KEY`; stop the API and worker and back up the database before applying it. See each program's header for its scope and safety constraints. Do not run these as part of a deployment or routine evaluation.
