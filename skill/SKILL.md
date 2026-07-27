---
name: selfbench
description: Convert merged pull requests into private, executable SWE-bench-style tasks, validate them, run agent rollouts, and audit benchmark quality.
---

# selfbench

Use this skill when creating or reviewing benchmark tasks from real software changes.

## Goal

A task is a sealed evaluation built from one completed change. The coding agent receives only a clean checkout at the base commit and the engineer's original work request. Held-out tests determine whether the agent reproduced the intended behavior. Rollouts execute in Modal and send model requests to the configured provider, so confirm that the source and prompt are permitted to leave the local machine.

Do not give the agent the source pull request, later commits, gold patch, test patch, or test names.

## Task contents

Each task directory contains:

```text
task.json
inputs/session.jsonl   # preferred: exported engineer/agent session
test.patch             # held-out tests
gold.patch             # expected non-test implementation
```

Use exactly one eval prompt source: either `prompt.md` or `prompt_source`. When the original session is available but its request needs a standalone reconstruction, keep the eval text in `prompt.md` and attach the session separately with `trace_source` for provenance review.

A minimal `task.json` looks like this:

```json
{
  "task_id": "project-pr-123",
  "repo": "example/project",
  "base_commit": "0123456789abcdef",
  "workdir": ".",
  "setup_cmd": "npm ci",
  "test_cmd": "npm test -- {tests}",
  "fail_to_pass": ["tests/regression.test.ts"],
  "pass_to_pass": ["tests/unit.test.ts", "tests/api.test.ts", "tests/cli.test.ts"],
  "test_paths": ["tests"],
  "source_pr": 123,
  "source_url": "https://github.com/example/project/pull/123",
  "prompt_source": {
    "path": "inputs/session.jsonl",
    "format": "auto",
    "message_index": 0
  }
}
```

The test command must contain `{tests}`. Test IDs are substituted with shell quoting at runtime.

## Step 1: choose a candidate

Prefer a recent, merged, human-reviewed change with a reproducible bug or missing behavior. Reject changes that require unavailable production services, secrets, nondeterministic external state, or manual-only verification.

Before building the task, identify the base commit that the change was made against. For a merge commit, this is normally its first parent. Confirm that the repository can be checked out at that commit and set up without relying on later files.

## Step 2: preserve the engineer's request

Use the original coding-agent session whenever one exists. Copy the JSON or JSONL export into `inputs/` inside the task directory, then reference it with `prompt_source`.

Supported formats are:

- `codex`: user-message events from a Codex rollout JSONL file.
- `claude-code`: external user records from a Claude Code session JSONL file.
- `pi`: user message records from a Pi session JSONL file.
- `generic`: JSON or JSONL records with `role: "user"` and textual content.
- `auto`: detect one of the formats above.

Use `message_index` to select the engineer turn that defined the work. It is zero-based; negative values count from the end. Inspect the resolved prompt in the review console before accepting the task.

Prefer generating one standalone user-voice prompt from the full original conversation over using a raw turn verbatim. Keep the eval text in `prompt.md` and preserve the coding session as private generation provenance:

```json
{
  "trace_source": {
    "path": "inputs/session.jsonl",
    "format": "auto"
  }
}
```

Generate the prompt with:

```bash
uv run selfbench generate-prompt tasks/<task> \
  --provider <provider> --model <model> \
  --confirm-source-upload --write --force
```

The generated request should sound like one coherent message from the original human: preserve their framing, terminology, directness, and material corrections; resolve conversational references; remove PR/commit/CI logistics and secrets; and do not import solution details that only appeared in assistant messages. Run the generator without tools, extensions, skills, project context files, or prompt templates. It must not receive or be able to inspect the gold patch, test patch, held-out test names, previous synthetic prompt, or working tree. Review the result against Original Session before accepting it.

If no coding session exists, require another authentic pre-implementation request such as the original issue, ticket, bug report, or user message, and attach it as provenance. A PR title/body written after implementation is not enough: it can encode the chosen solution and exact names. If no authentic request can establish what was actually asked, reject the candidate rather than reconstructing a prompt from the PR, gold patch, or tests.

## Step 3: split the change

Generate `test.patch` from test-only files and `gold.patch` from implementation-only files. Include binary changes when necessary.

```bash
git -C <repo> diff --binary <base> <completed> -- <test-files...> > tasks/<task>/test.patch
git -C <repo> diff --binary <base> <completed> -- <implementation-files...> > tasks/<task>/gold.patch
```

The patches must not touch the same file. Reject candidates whose production and test changes cannot be cleanly separated by file.

List every file or directory owned by `test.patch` in `test_paths`. Agent edits below these paths are stripped before grading.

## Step 4: select tests

`fail_to_pass` contains focused tests that fail on the base commit with only `test.patch` applied, then pass after `gold.patch` is applied. `pass_to_pass` contains existing regression tests that already pass at the base and must continue to pass.

A test from the source change is not automatically a valid held-out test. Before selecting it, perform an equivalent-design check: imagine an implementation that satisfies the human request with different private names, data flow, or helper boundaries. If that implementation would fail the test, exclude the test. In particular, reject tests that construct, read, import, or monkeypatch a field, helper, constant, intermediate payload, sidecar filename, archive layout, or fixed byte offset introduced only by the gold patch unless the authentic human request explicitly named that public contract. Describing a concept in prose (for example, “return the auth subject” or “accept a version identifier”) does not specify a JSON key such as `auth_subject` or `version_id`; held-out tests must not require that exact spelling unless the source request did. Do not test “deterministic output” by asserting the gold implementation's gzip header value; generate the same logical input under different clock values and compare the complete outputs. Assert end-to-end observable state, output, persistence, or API behavior instead. If no focused behavioral tests remain, reject the candidate rather than grading agents on whether they reproduced the gold implementation.

Use at least three meaningful pass-to-pass entries when possible. Avoid broad suites that make every rollout slow when focused package or test-file targets exist.

Common command templates include:

| Project | Setup | Test command |
|---|---|---|
| Python with uv | `uv sync --group dev --frozen` | `uv run pytest -q {tests}` |
| Go | `go build ./...` | `go test {tests}` |
| Bun | `bun install --frozen-lockfile` | `bun test {tests}` |
| npm | `npm ci` | `npm test -- {tests}` |

## Step 5: validate

Run the gold validator before any model rollouts:

```bash
uv run selfbench validate tasks/<task> --repo <local-repo>
```

Acceptance requires all of the following:

- The fail-to-pass tests fail at the base.
- Pass-to-pass tests pass at the base.
- The gold patch applies cleanly.
- Fail-to-pass tests pass with the gold patch twice in succession. This catches obvious flakes but does not prove full determinism.
- Pass-to-pass tests still pass with the gold patch.

The validator uses separate fresh sandboxes for the base and gold checks. A rollout uses another two-sandbox boundary: the agent receives only the base snapshot and prompt, then its captured patch is graded in a fresh sandbox with the held-out tests. Never place `gold.patch` or `test.patch` in the agent sandbox, and never grade in a sandbox that executed the agent.

If validation fails, correct the base commit, patch split, setup command, or test IDs. Do not weaken a legitimate test merely to make the task pass.

Run the quality audit once before spending model calls:

```bash
uv run selfbench audit tasks/<task> --results results
```

Missing rollout signal is expected at this stage, but any blocker about gold-coupled private identifiers must be fixed by replacing the test or rejecting the candidate.

## Step 6: run models

Run at least two representative models so the task has measurable solver signal:

```bash
uv run selfbench run tasks/<task> --repo <local-repo> --provider <provider> --model <model>
```

Each rollout receives the resolved engineer prompt, edits a clean snapshot, and produces an agent patch. The grader removes held-out test edits, applies `test.patch`, and runs fail-to-pass plus pass-to-pass tests.

Each run is preserved under `results/<task>/<model>/runs/<run-id>/`; the model directory's top-level `result.json` is only the latest-result compatibility view. Changing task inputs or the result schema makes prior validation and rollout artifacts stale, so rerun validation before interpreting new scores.

## Step 7: audit and review

Run the quality audit:

```bash
uv run selfbench audit tasks/<task> --results results
```

Then open the review console:

```bash
uv run selfbench review --host 0.0.0.0 --port 8765 --tasks tasks --results results
```

Check the generated prompt against the human turns in Original Session when a source trace is attached. Then review the patch split, validation tails, rollout output, and model patches. Generated-prompt rollouts must show a current prompt fingerprint; stale results do not count as solver signal. Record any reviewed warnings and rationale in the review panel.

The final verdicts are:

- `accepted`: validation passes, quality gates pass, and the standard model outcomes are mixed.
- `needs_review`: the task executes but lacks clean solver signal or has a warning requiring judgment.
- `rejected`: validation or a blocking quality requirement fails.

## Quality rules

Reject or repair tasks with any of these defects:

- The prompt names held-out tests, new solution identifiers, patch files, or implementation steps.
- The test patch and gold patch overlap.
- Tests assert irrelevant internal structure rather than externally meaningful behavior.
- A test requires private names, fields, helpers, constants, intermediate payloads, sidecar filenames, archive layout, fixed byte offsets, or control flow introduced only by the gold patch. Equivalent implementations must be able to pass.
- The task has no authentic pre-implementation request provenance and was reconstructed from a PR description, implementation, or tests.
- The task omits essential context that an engineer had when receiving the request.
- The base already passes fail-to-pass tests.
- The gold implementation does not pass the selected tests deterministically.
- Pass-to-pass coverage is absent.

Keep private task material in the ignored `tasks/` directory. Do not commit source transcripts, proprietary patches, repository snapshots, or rollout results to the toolkit repository.
