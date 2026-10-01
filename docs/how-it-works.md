# How SelfBench works

SelfBench turns merged pull requests into Harbor tasks. This page covers the pipeline, the rules an accepted task must meet, and what an export contains.

## Terms

- A **candidate** is one source pull request being turned into a task.
- The **base snapshot** is the repository state before the change.
- The **reference patch** (gold) is the PR's non-test implementation.
- The **held-out test patch** is grader code hidden from evaluated agents.
- A **fail-to-pass** test fails on the base snapshot and passes after a correct implementation; a **pass-to-pass** test already passes and guards existing behavior.
- Harbor's **nop** run applies no solution; its **oracle** run applies the reference patch.

## Pipeline

A batch is one `selfBenchBatchWorkflow` (`src/generation/batches/`), with each discovery shard and each candidate as its child workflow, the same shape as an evaluation. Each step writes the batch's Postgres record, which the batch page reads; a running child's progress and cost are read from Temporal. Cancelling the batch cancels every child and waits for each to stop.

1. **Provenance.** The API pins the default branch's head; the batch workflow then lists up to 500 merged PRs with the submitter's GitHub token. Each PR from a non-bot author that clears the size gate becomes a provenance record: its exact title and body, with common credential forms redacted. No model writes request text.
2. **Discovery.** PRs are split into shards, each one `selfBenchDiscoveryShardWorkflow`. Each shard sees a pool of about 1.5× the requested count in PRs (at least 25) and proposes up to its share of each tier's count. Candidates are deduplicated by source PR.
3. **Authoring and review.** Every candidate runs as one `selfBenchAuthorWorkflow`. Nothing is backfilled: a rejected candidate is a rejection in the batch status, and a batch can accept more tasks than it asked for.
4. **Export.** Once every candidate settles, accepted tasks are packed into the batch export.

**Add PRs** skips discovery and authors each chosen PR as its own candidate.

Agents run in fresh sandboxes (Docker locally; Modal, Vercel, or E2B hosted) built from `Dockerfile.sandbox`. A sandbox reports back to the API over signed callbacks (`/api/sandbox/*`) rather than holding a worker connection, and uploads everything it produces under `runs/<runId>/…` in the artifact store. Harbor gates and solver trials run on a separate `<task queue>-harbor` queue, which the GKE workers serve in production.

Evaluations from the **Run** page are one `selfBenchEvaluationRunWorkflow` per model, with one child `selfBenchSolverTrialWorkflow` per task and harness. Each trial is one Harbor run with only the selected credentials.

## Authoring and verification

One authoring agent session owns the whole task: the instruction, the test command and test selection, and the environment contract (base image, setup, smoke command, services). It writes `/work/task/` (`definition.json`, `instruction.md`, `test.patch`, `gold.patch`) and calls `verify`.

`verify` runs a static check in the sandbox (schema, environment policy, patch path safety, and a dry render of the Harbor tree) and returns failures immediately. Otherwise it ends the turn, and the worker compiles the task and runs the Harbor gates:

1. **smoke**: the smoke command succeeds as the agent (agent image, user, and network allowlist);
2. **nop**: the new tests fail on the base snapshot and the regression tests pass;
3. **oracle**: the reference patch applies and every selected test passes;
4. **determinism**: the fail-to-pass tests pass a second time with the oracle.

The next turn resumes the same session in a fresh sandbox with the report as its next message. A round allows five `verify` calls and ends with `submit_task`. A fresh read-only review agent then judges each green submission: accept, reject, or send suggestions back for another authoring round. Three failed rounds reject the candidate; a step that still fails after its retries (a Harbor check gets four attempts) marks it `infrastructure_failed`.

The authoring prompt, including the anti-coupling rules, is [`src/generation/pipeline/prompts/authoring.md`](../src/generation/pipeline/prompts/authoring.md).

## What an accepted task must satisfy

| Difficulty | Reference patch | Fail-to-pass | Pass-to-pass |
| --- | --- | --- | --- |
| easy | 20+ changed lines across 1 implementation path | 1+ | — |
| medium | 50+ changed lines across 2 implementation paths | 1+ | 1+ |
| hard | 100+ changed lines across 3 implementation paths | 1+ | 2+ |

Every task also needs a held-out test patch that shares no files with the reference patch, deterministic repository-native setup and tests, green smoke/nop/oracle gates, and the reviewer's acceptance.

- **Instruction.** It may restate the PR's request but may not add behavior inferred only from the implementation or tests.
- **No test-to-gold coupling.** Held-out tests exercise a public API, command, persistence boundary, or extension seam. They may not import the gold's private helpers or pin internal SQL, query counts, private schemas, telemetry layout, incidental error wording, or UI composition unless the request makes that public.
- **Environment.** The agent derives runtime, dependencies, fixtures, and services from the pinned commit's CI, Dockerfiles, devcontainer, and lockfiles. The agent names images by tag, or by a digest the repository itself pins; the trusted compiler pins each tag to the digest its registry serves and rejects a reference the registry does not serve, so every compiled task builds from digest-pinned images. Secret-named variables take only fixed placeholders. Services render as Docker Compose, so tasks with services cannot verify on E2B (Harbor's E2B environment drops the compose file). When the gold changes a dependency manifest, the hidden verifier image reruns setup with it and resets source files to the base.

## What the evaluated agent sees

The agent gets the base snapshot, the instruction, and the task's environment. It never sees the held-out tests or the reference solution; Harbor mounts `solution/` only for the oracle.

The agent runs as `root` in `/app` after `setup.sh`, with network limited to the model provider's hosts. Its diff is taken against the post-setup snapshot. The verifier refuses the patch unless its recorded base tree matches the verifier's own `HEAD`, then applies it to a clean copy with test paths excluded and restores the held-out and regression test files, so tampering can only produce a tree the agent could have written directly.

## Export

A batch export is a `.tar.gz`, downloaded with `GET /v1/runs/:runId/export` (see the [HTTP API](api.md)):

```text
manifest.json
tasks/
└── TASK_ID.tar.gz
    └── harbor-task/
        ├── task.toml
        ├── instruction.md
        ├── environment/
        ├── tests/
        └── solution/
```

`manifest.json` pins the source commit, SelfBench build, generation backend, Harbor environment, task IDs, and archive SHA-256s. The export keeps the first accepted task per source PR and lists the rest under `droppedDuplicates`.

Exports contain repository snapshots, hidden tests, and reference solutions, unencrypted. Keep them private. Any exported task runs with plain Harbor on any environment:

```bash
harbor run --path ./harbor-task --agent codex --model gpt-6-sol --env docker
```
