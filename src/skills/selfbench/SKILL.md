---
name: selfbench
description: Author one private software-engineering benchmark task at an assigned difficulty from a completed pull request. Use when SelfBench supplies a pinned candidate, authentic request provenance, base and completed commits, and a difficulty.
---

# SelfBench Task Authoring

Create exactly one Harbor evaluation at the assigned easy, medium, or hard difficulty. Do not discover alternative pull requests. Do not run Harbor; the worker compiles, builds, and measures your submission and sends the verification report back to this session. Your deliverable is the directory `/work/task/` with exactly four files: `definition.json` (with the environment contract), `instruction.md`, `test.patch`, and `gold.patch`. The `verify` and `submit_task` tools take no arguments; they read that directory.

## Integrity boundary

The coding agent must receive only a history-free base snapshot and the authentic engineering request. Never place any of the following in the prompt:

- pull request numbers or URLs;
- commit hashes or branch names;
- test names, test paths, or test commands;
- implementation details learned from the completed change;
- gold-patch or held-out-test content.

Use the supplied provenance only to preserve the engineer's original intent. Do not reconstruct a request from the pull request, implementation, or tests.

## Difficulty gate

Use the assigned difficulty exactly. Reject the candidate instead of changing its tier or weakening its thresholds:

| Difficulty | Implementation core | Fail-to-pass | Pass-to-pass |
| --- | --- | --- | --- |
| easy | at least 20 changed lines across 1 implementation file | at least 1 | no minimum |
| medium | at least 50 changed lines across 2 implementation files | at least 1 | at least 1 |
| hard | at least 100 changed lines across 3 implementation files | at least 1 | at least 2 |

Every tier also requires one coherent behavioral requirement, held-out tests that do not remove solver-required implementation, deterministic clean-checkout setup, no private or mutable external dependency, and completion within declared resource limits.

## Authoring procedure

1. Verify that the base commit is an ancestor of the completed commit.
2. Inspect the complete diff and repository-native test setup.
3. Classify changed paths as implementation, test, generated, documentation, or unrelated.
4. Build `goldPatch` from only the implementation required for the requested behavior. Exclude tests, generated artifacts, formatting churn, and unrelated cleanup.
5. Build `testPatch` from only held-out behavioral tests and minimal test fixtures. It must not overlap any path in `goldPatch`.
   - Exercise a public API, command, persisted behavior, or existing extension seam. Do not import a
     private helper or new internal module introduced by the gold patch merely because it is easy to
     test directly.
   - Do not require exact helper names, wrapper identity, SQL text/query counts, database index names,
     private telemetry shapes, or internal error wording unless the authentic request makes that exact
     artifact part of the public contract.
   - Do not pin an endpoint path, response field/media type, UI copy, wizard step number/order, markup,
     or presentation format merely because the gold patch chose it. Only assert those details when the
     authentic request explicitly makes them part of the contract.
   - Assert the requested semantic value rather than a larger retained/raw payload that happens to
     contain it. A request for natural-language reasoning, for example, must not require exposing an
     internal machine-readable action alongside it.
   - When the request is about an externally visible endpoint or provider contract, exercise that
     boundary. Do not manually compose internal translators, context builders, option builders, model
     factories, or other pipeline stages to simulate it.
   - Preserve and assert all valid adjacent input content unless the authentic request explicitly says
     it should be discarded. Do not copy a gold adapter's filtering behavior into the expected result.
   - A materially different implementation that satisfies the request must be able to pass. If there is
     no stable public seam for testing the behavior, reject the candidate.
   - Cover every material behavior named in the task prompt, including authorization, error, and UI
     states when those are central. Reject a candidate rather than submitting narrow tests that pin one
     implementation while leaving most of the request unverified.
6. Select exact fail-to-pass and pass-to-pass test identifiers supported by one deterministic test command.
7. Write a standalone prompt in the engineer's voice. Preserve required behavior, constraints, and acceptance criteria without leaking the completed solution.
8. Author the environment contract from the pinned base commit: base image pinned by digest, root setup, dependency setup, smoke command, non-secret environment variables, services with health checks, and repository-file evidence. Derive it from the closest CI job, repository Dockerfile, devcontainer, lockfiles, and test scripts.
9. Write the deliverable to `/work/task/`, call `verify` until it is green, then call `submit_task` once. If the verify budget runs out before a green report, submit your best deliverable anyway: the worker verifies it and a red result opens the next round with the report, whereas an unsubmitted round rejects the task. Both tools run the static check (files present, schema, environment policy, patch path safety, audit gates, dry render) immediately and return failures for you to fix in the same session; only a passing submission ends the round. Do not write an alternate task format.

## Deliverable files

`/work/task/instruction.md` holds the standalone instruction; it is authoritative for the prompt, so omit `prompt` from `definition.json` or keep it identical. `/work/task/test.patch` and `/work/task/gold.patch` are Git patches (start with `diff --git`; produce them with `git diff`). `/work/task/definition.json` has this shape (shown with the derived prompt):

```json
{
  "definition": {
    "schemaVersion": 2,
    "difficulty": "medium",
    "taskId": "project-pr-123",
    "repo": "example/project",
    "baseCommit": "0123456789abcdef0123456789abcdef01234567",
    "workdir": ".",
    "testCommand": "bun test {tests}",
    "failToPass": ["tests/new-behavior.test.ts"],
    "passToPass": ["tests/existing-a.test.ts", "tests/existing-b.test.ts"],
    "testPaths": ["tests/new-behavior.test.ts"],
    "sourcePr": 123,
    "sourceUrl": "https://github.com/example/project/pull/123",
    "prompt": "Implement the requested behavior...",
    "timeouts": {
      "setupSeconds": 900,
      "agentSeconds": 2400,
      "testsSeconds": 900
    },
    "resources": {
      "cpus": 4,
      "memoryMb": 8192,
      "storageMb": 20480
    },
    "environment": {
      "schemaVersion": 1,
      "baseImage": "node:22-bookworm@sha256:...",
      "rootSetupCommand": "apt-get update && apt-get install -y --no-install-recommends bash git passwd procps tar",
      "setupCommand": "bun install --frozen-lockfile",
      "smokeCommand": "bun --version",
      "environmentVariables": { "CI": "1" },
      "services": [],
      "source": "ci-adapted",
      "evidence": [{ "path": ".github/workflows/ci.yml", "reason": "Defines the test job." }]
    }
  },
  "testPatch": "diff --git ...",
  "goldPatch": "diff --git ..."
}
```

`testCommand` must contain the literal `{tests}` placeholder. Paths must be repository-relative and must not contain `..`. Secret-named environment variables are accepted only with fixed placeholder literals.

## What the compiler renders

The trusted compiler on the worker turns your submission into a native Harbor task. You never write these files; `verify` and `submit_task` dry-render the same tree to `/work/rendered/` so you can inspect exactly what will be built.

```
harbor-task/
  task.toml            ← timeouts, resources, agent/verifier settings from the definition
  instruction.md       ← definition.prompt (what the evaluated agent reads)
  definition.json      ← the submitted definition (with environment contract)
  environment/         ← agent image build context
    Dockerfile         ← FROM environment.baseImage; ENV from environmentVariables; COPY + run root-setup.sh;
                         unpack repo.tar.gz into /app; git init/commit base; run setup.sh from /app/<workdir>;
                         commit the post-setup tree (baseline for the agent's diff); create user "agent",
                         snapshot .git to /opt/selfbench/base.git
    root-setup.sh      ← environment.rootSetupCommand (runs as root, /bin/sh)
    setup.sh           ← environment.setupCommand (bash, cwd /app/<workdir>)
    smoke.sh           ← environment.smokeCommand (bash, cwd /app/<workdir>), run by the smoke gate before any test
    repo.tar.gz        ← git archive of baseCommit (never contains tests/solution)
  tests/               ← verifier image build context (separate container, user "verifier")
    Dockerfile         ← same base layers as environment/, plus /tests with test.patch and the scripts;
                         when the gold patch changes a dependency manifest, setup.sh runs again with
                         dependency-setup.patch applied and only those manifest paths are reset to the base
    test.patch         ← the held-out test patch; applied by test.sh at verify time
    test.sh, task-test.sh ← generated verifier: apply test.patch, run testCommand with failToPass (twice, for
                            determinism) then passToPass under runuser verifier, write rewards
                            (patch_applied, fail_to_pass, pass_to_pass, deterministic, setup_completed)
    docker-compose.yaml ← only when environment.services is non-empty (services with health checks)
    root-setup.sh, setup.sh, smoke.sh, repo.tar.gz ← copies, because a Docker build context cannot reach outside itself
  solution/
    gold.patch         ← the gold patch; applied only by the oracle agent
    solve.sh           ← git apply of gold.patch
```

Each verify gate maps to those files, so a red gate tells you which field to change:

- **compile** (worker): schema, environment policy, patch path safety, evidence paths at the pinned commit → definition, environment contract, patch headers.
- **audit**: tier thresholds, gold/test overlap, `{tests}` placeholder rules → goldPatch, testPatch, testCommand, failToPass, passToPass.
- **build**: both Dockerfiles → baseImage, rootSetupCommand, setupCommand, environmentVariables, workdir, services.
- **smoke**: smoke.sh in the verifier image → smokeCommand (and whatever setup it relies on).
- **nop**: test.sh on the base snapshot with test.patch applied, no solution → failToPass must fail, passToPass must pass; testCommand, test selection, held-out tests.
- **oracle**: test.sh after gold.patch → both selections pass deterministically; goldPatch, tests, timeouts, resources.

## Patch rules

- When a change spans backend and frontend, anchor the held-out tests on the backend contract through its public boundary; tests that mock the API and check only rendering are rejected as unfair.
- Never touch paths the repository marks `export-ignore` in `.gitattributes` (for PostHog that includes everything under `.github/`): the snapshot the solver and the verifier receive is a `git archive`, so those files do not exist there and the static check rejects patches that reference them. If a change lives only in such paths, decline the task.
- Produce binary-safe Git patches beginning with `diff --git`, with LF line endings and a final newline (use `git diff`). Both must apply cleanly to the base commit, and the gold patch must apply on top of the test patch; `verify` checks this with `git apply --check` before any build.
- Keep test and gold paths disjoint.
- Exclude dependency caches, lockfile churn unrelated to the change, build output, vendored code, and generated files.
- Do not patch around a broken base repository. Environment reproducibility is proven by the worker's build, smoke, nop, and oracle gates.
- Do not include source transcripts or provenance records in either patch.

## Final check

Before submission, re-read the prompt without looking at the completed diff. It must be sufficient to implement the behavior but insufficient to recover the hidden implementation. Confirm the test patch observes public behavior and would fail a plausible wrong implementation, not merely the base commit. Then imagine a second correct implementation with different file boundaries and helper names; the held-out tests must still pass it.
