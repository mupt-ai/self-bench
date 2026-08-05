# Generate tasks in Modal Sandboxes

Selfbench can keep candidate discovery local—where Pi can inspect existing tasks, rejected
candidates, and authentic local coding sessions—then author each assigned pull request in a fresh
Modal Sandbox. A deterministic coordinator owns the Modal credentials and fan-out. Child agents
never select replacement pull requests or share a task directory.

This workflow generates and retrieves authoring artifacts. It does not run coding-agent solver
trials. A generated task is not accepted until the normal nop/oracle validation, audit, and coupling
review pass.

## Execution model

1. A read-only local Pi parent ranks `count + reserve_count` merged pull requests. It verifies an
   authentic pre-implementation provenance source and emits a schema-validated plan.
2. The coordinator locally extracts the selected engineer prompt, redacts recognized credential
   forms (including common bearer, AWS, npm/GitLab, database/password, and private-key forms), and
   uploads it as a one-message generic JSON artifact to a private Modal Volume. Raw session exports,
   tool results, assistant responses, and other human turns are never uploaded. This is
   defense-in-depth pattern filtering, not a guarantee that arbitrary prose contains no sensitive
   data. Source paths are restricted to the source repository and known Pi, Claude, Codex, relaymux,
   and handoff roots; credential-like source files and provenance files larger than 50 MiB are
   rejected.
3. The coordinator starts one candidate per Modal Sandbox, up to the configured concurrency. Each
   Sandbox has an isolated repository clone, Pi session, and output path.
4. A child either publishes one task or records a structured rejection. Rejections consume the next
   ranked reserve; infrastructure failures stop the run so the same candidate can be retried.
5. Before publishing `_SUCCESS`, the child compiles the task through Selfbench's production Harbor
   environment compiler. That resolves the exact base-snapshot package manager and lockfile hashes
   and rejects conflicting or mutable setup commands. The child then creates a fresh detached base
   worktree, activates the resolved manager version, and executes the authored `setup_cmd` with its
   declared timeout.
6. The coordinator downloads the completed worker artifacts, verifies every file hash and source PR,
   rejects duplicates, and idempotently merges exactly the requested number of tasks locally.

The setup command is executed again with the tests in the generated Harbor environments. The child
setup smoke is deliberately not a substitute for nop/oracle validation: Harbor's history-free image,
held-out patch application, base failure, and oracle success remain the canonical proof.

## Prepare Modal

Install the optional Modal dependency and authenticate the CLI:

```bash
uv sync --extra modal
uv run modal setup
```

Create a private Modal Secret named `selfbench-generation` using the Modal dashboard. It should hold
the provider credential used by the child Pi agents and, for private repositories, `GITHUB_TOKEN` or
`GH_TOKEN`. For example, an OpenAI run needs `OPENAI_API_KEY`.

The default private Volume is `selfbench-generation-artifacts`. Override these names without editing
the plan:

```bash
export SELFBENCH_MODAL_SECRET=my-selfbench-secret
export SELFBENCH_MODAL_VOLUME=my-selfbench-artifacts
export SELFBENCH_MODAL_MAX_WORKERS=10
```

## Run discovery and generation

Run from a clean, committed Selfbench checkout. The image records the exact Selfbench commit and the
coordinator refuses a dirty checkout so a later run can be reproduced.

```bash
uv run modal run scripts/modal_generate.py::run \
  --repo ~/code/my-project \
  --tasks-root ./tasks \
  --count 10 \
  --reserve-count 10 \
  --profile hard \
  --provider openai \
  --model gpt-5.6-sol \
  --thinking xhigh
```

The parent plan and private JSONL log stay outside the repository under
`~/.local/share/selfbench/modal-runs/RUN_ID/`. The successful run is downloaded under the adjacent
`artifacts/` directory and merged into `--tasks-root`.

Every candidate packet pins its source PR, base commit, completed commit, and provenance descriptor.
The child prompt explicitly forbids candidate substitution, lockfile mutation, or switching package
managers to make setup pass.

## Resume or retrieve a run

A stopped run can be resumed from its reviewed local plan. Completed workers are skipped, rejected
candidates stay rejected, and failed workers are retried before reserves are consumed:

```bash
uv run modal run scripts/modal_generate.py::submit \
  --manifest ~/.local/share/selfbench/modal-runs/RUN_ID/plan.json \
  --repo ~/code/my-project
```

Download and merge a completed run again without regenerating anything:

```bash
uv run modal run scripts/modal_generate.py::pull \
  --run-id RUN_ID \
  --output ./tasks
```

Reduction is restart-safe. An identical existing task is retained; a different directory with the
same task ID, a duplicate source PR, a stale completion marker, or a changed artifact hash stops the
merge.

## Validate the generated batch

Run deterministic validation after generation. The default Modal path builds and executes the exact
agent and verifier environments; local Docker preflight catches shared setup failures before the
remote fan-out:

```bash
selfbench validate-batch ./tasks \
  --repo-map example/project=~/code/my-project \
  --env modal \
  --concurrency 4
```

Then run the static audit and independent coupling review described in
[Authoring evals](authoring-evals.md). Do not run solver agents unless that separate spend is
explicitly requested.

## Private artifact layout

```text
runs/RUN_ID/
├── manifest.json
├── inputs/WORKER_ID/PROVENANCE_SHA.jsonl
├── statuses/WORKER_ID.json
├── failures/WORKER_ID/
└── workers/WORKER_ID/
    ├── _SUCCESS
    ├── artifacts.json
    ├── request.json
    ├── setup-preflight.json
    ├── stdout.log
    ├── stderr.log
    └── tasks/TASK_ID/
```

Worker logs and provenance remain private. The coordinator prints only compact status objects, not
Pi transcripts or source material.
