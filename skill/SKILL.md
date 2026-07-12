---
name: make-your-swebench
description: Convert merged pull requests into private, executable SWE-bench-style tasks, validate them, run agent rollouts, and audit benchmark quality.
---

# Make Your SWE-bench

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

If no source session is available, use `prompt.md` instead of `inputs/session.jsonl`. Never provide both `prompt.md` and `prompt_source`.

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

Only write `prompt.md` when no authentic session input exists. In that fallback, describe the observed behavior, expected behavior, constraints, and success criteria without revealing the implementation.

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
uv run mysb validate tasks/<task> --repo <local-repo>
```

Acceptance requires all of the following:

- The fail-to-pass tests fail at the base.
- Pass-to-pass tests pass at the base.
- The gold patch applies cleanly.
- Fail-to-pass tests pass with the gold patch twice in succession. This catches obvious flakes but does not prove full determinism.
- Pass-to-pass tests still pass with the gold patch.

If validation fails, correct the base commit, patch split, setup command, or test IDs. Do not weaken a legitimate test merely to make the task pass.

## Step 6: run models

Run at least two representative models so the task has measurable solver signal:

```bash
uv run mysb run tasks/<task> --repo <local-repo> --provider <provider> --model <model>
```

Each rollout receives the resolved engineer prompt, edits a clean snapshot, and produces an agent patch. The grader removes held-out test edits, applies `test.patch`, and runs fail-to-pass plus pass-to-pass tests.

## Step 7: audit and review

Run the quality audit:

```bash
uv run mysb audit tasks/<task> --results results
```

Then open the review console:

```bash
uv run mysb review --host 0.0.0.0 --port 8765 --tasks tasks --results results
```

Check the resolved prompt and source metadata, patch split, validation tails, agent traces, and model patches. Record any reviewed warnings and rationale in the review panel.

The final verdicts are:

- `accepted`: validation passes, quality gates pass, and the standard model outcomes are mixed.
- `needs_review`: the task executes but lacks clean solver signal or has a warning requiring judgment.
- `rejected`: validation or a blocking quality requirement fails.

## Quality rules

Reject or repair tasks with any of these defects:

- The prompt names held-out tests, new solution identifiers, patch files, or implementation steps.
- The test patch and gold patch overlap.
- Tests assert irrelevant internal structure rather than externally meaningful behavior.
- The task omits essential context that an engineer had when receiving the request.
- The base already passes fail-to-pass tests.
- The gold implementation does not pass the selected tests deterministically.
- Pass-to-pass coverage is absent.

Keep private task material in the ignored `tasks/` directory. Do not commit source transcripts, proprietary patches, repository snapshots, or rollout results to the toolkit repository.
