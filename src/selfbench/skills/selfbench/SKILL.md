---
name: selfbench
description: Convert merged pull requests into private, executable SWE-bench-style tasks, validate them, run agent rollouts, and audit benchmark quality.
---

# selfbench

Use this skill when creating or reviewing benchmark tasks from real software changes.

## Goal

A task is a sealed evaluation built from one completed change. The coding agent receives only a clean checkout at the base commit and the engineer's original work request. Held-out tests determine whether the agent reproduced the intended behavior. Rollouts execute in Harbor Docker containers and send model requests to the configured provider, so confirm that the source and prompt are permitted to leave the local machine.

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

## Step 1: discover and choose candidates

When the user supplies a pull request or commit, evaluate that candidate directly. When no candidate is supplied, choose candidates autonomously instead of asking the user for PR numbers:

1. Resolve the repository slug from its `origin` remote and list merged pull requests with `gh`. Start with recent changes and expand the search window if the first batch yields no strong candidates.
2. Read every `task.json` below the requested task root, including rejected-task directories. Exclude pull requests already represented by `source_pr` or `source_url`; do not retry a known rejection under a new task name unless the user explicitly asks.
3. Triage unseen pull requests from metadata and changed paths. Prioritize changes that modify separable implementation and test files, have a focused behavioral requirement, are small enough to understand, and are likely reproducible in a clean checkout. Metadata filtering is only a shortlist: inspect the actual diff and test design before accepting a candidate.
4. Search thoroughly for authentic pre-implementation provenance for the whole shortlist before authoring tasks. Check local Pi, Claude Code, Codex, and relaymux sessions, worktree names, implementation journals, linked issues, and other original request artifacts. Read the human turns, not just filenames or keyword hits. Reject candidates whose request cannot be recovered without reconstructing it from the PR, implementation, or tests.
5. Rank the provenance-backed shortlist and set a batch target `N` before creating anything. Use the user's requested count when supplied; otherwise choose and record a reasonable target from the strong candidates available. Reject weak candidates quickly and continue down the ranking. Do not ask the user to nominate PRs unless repository access or another hard blocker prevents autonomous selection.

For a GitHub repository, a useful initial query is:

```bash
gh pr list -R <owner/repo> --state merged --limit 100 \
  --json number,title,body,additions,deletions,files,mergedAt,author
```

Prefer a recent, merged, human-reviewed change with a reproducible bug or missing behavior. Reject changes that require unavailable production services, secrets, nondeterministic external state, manual-only verification, or unavailable authentic request provenance.

Passing validation once does not make a task reproducible. `setup_cmd` resolves dependencies fresh on every rebuild, so upstream releases silently break tasks that validated months — or hours — earlier. Pin build-time tooling whenever the source repository's packaging predates current standards: pass build constraints to the installer (for example `uv pip install --build-constraints`, which pins the backend used in uv's *isolated* build environment; installing the backend into the project venv does not affect it) and pin any version-deriving plugin the build needs. Treat an old validation result as unproven and revalidate before trusting it.

Before building a task, identify the base commit that the change was made against. For a merge commit, this is normally its first parent. Confirm that the repository can be checked out at that commit and set up without relying on later files.

## Difficulty profiles

The launch prompt may name a difficulty profile. When none is named, use `default`. Profiles change only how Step 1 shortlists and ranks candidates; every other step, gate, and rejection rule in this skill applies unchanged to both profiles.

### default

The Step 1 guidance as written: prefer focused merged changes that are small enough to understand quickly.

### hard

Target larger, more complex merged PRs. Size metadata is a shortlist signal, never an acceptance criterion; a big diff that fails a quality gate is rejected, not weakened.

1. Shortlist from PR metadata (`additions`, `deletions`, `files`): prefer merged PRs with at least 5 changed files and at least 150 changed lines (additions plus deletions, tests included). Rank the roughly 150–1500 changed-line band highest. This metadata pass is only a cheap first filter: PR-envelope size includes changelogs, version bumps, and bundled noise, so acceptance is always judged on the separable implementation core defined in rule 4.
2. Exclude from the shortlist regardless of size: docs-only, formatting/style-only, dependency or lockfile bumps, generated or vendored code, release/changelog chores, and broad mechanical refactors (mass renames, file moves, API churn without behavior change). A behavioral change extracted from such a PR (for example a feature buried inside a release bundle) counts as hard only when its separable implementation core itself meets the bar in rule 4.
3. Rank the shortlist by reading the actual diffs, not by line count. Prefer candidates with one coherent behavioral requirement that spans multiple modules or layers, meaningful implementation changes plus meaningful separable test changes, and nontrivial control-flow or data-model work over repetitive single-pattern edits. A 300-line change with real cross-module logic outranks a 900-line change of copy-paste edits.
4. Judge difficulty on the separable implementation core — the files that would form `gold.patch` — not the PR envelope. A hard task needs roughly 100+ changed implementation lines across 3+ implementation files after the test/implementation split. A PR whose envelope is large but whose extracted core falls below this bar is not a hard candidate; treat it as default-profile material. Keep a smaller core on the hard shortlist only for an unusually intricate behavioral requirement, and record that justification with the task.
5. Apply every existing gate unchanged: authentic pre-implementation provenance, file-separable test and implementation patches, the equivalent-design test check (including dependency coupling), and deterministic nop/oracle validation.
6. The hard profile's standing goal is 15 validated tasks per repository; a user-supplied batch count overrides that number. The target counts tasks that pass deterministic nop/oracle validation, not shortlisted PRs or authored directories. Batch-first ordering still applies: rank the provenance-backed shortlist, author the full target batch, then validate and audit it. After that pass, replace tasks that were rejected or failed validation with the next ranked provenance-backed candidates, author and validate the replacements as their own follow-up batch, and repeat until the target number of tasks passes validation. Stop short only when the viable provenance-backed pool is exhausted, and then report the exact blocker and the shortfall rather than weakening a gate. Do not ask the user to nominate PRs.

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
selfbench generate-prompt tasks/<task> \
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

A test from the source change is not automatically a valid held-out test. Before selecting tests, run this mechanical checklist: list every function, method, class, signature, option name, dictionary key, header value, and error string the candidate held-out tests reference, and verify each one either (a) exists at the base commit, (b) is named in the authentic request or eval prompt, or (c) is dictated by a public spec the prompt invokes. Anything that fails all three is gold-coupled: exclude the test, rewrite it against observable behavior, or reject the candidate. Also verify the tests do not depend on helpers, fixtures, or imports that the source change added outside the files carried by `test.patch`.

Beyond the checklist, perform an equivalent-design check: imagine an implementation that satisfies the human request with different private names, data flow, or helper boundaries. If that implementation would fail the test, exclude the test. In particular, reject tests that construct, read, import, or monkeypatch a field, helper, constant, intermediate payload, sidecar filename, archive layout, or fixed byte offset introduced only by the gold patch unless the authentic human request explicitly named that public contract. Describing a concept in prose (for example, “return the auth subject” or “accept a version identifier”) does not specify a JSON key such as `auth_subject` or `version_id`; held-out tests must not require that exact spelling unless the source request did. Do not test “deterministic output” by asserting the gold implementation's gzip header value; generate the same logical input under different clock values and compare the complete outputs. Assert end-to-end observable state, output, persistence, or API behavior instead. If no focused behavioral tests remain, reject the candidate rather than grading agents on whether they reproduced the gold implementation.

Also check dependency coupling: if the gold implementation's behavior depends on adding or upgrading a dependency (a load-bearing manifest or lockfile change, not an incidental one), the authentic request — and therefore the eval prompt derived from it — must convey that the dependency change is needed. If it does not, reject the candidate: a solver working from the prompt and a clean checkout cannot know to change dependency versions, and no equivalent code-only implementation can pass.

Use at least three meaningful pass-to-pass entries when possible. Avoid broad suites that make every rollout slow when focused package or test-file targets exist.

## Required creation pipeline

`selfbench create` may author, deterministically validate, statically audit, and coupling-review tasks. It must never run coding-agent/model solver trials unless the user explicitly asks. During creation, run these stages in order:

1. **Author the full batch.** For each ranked candidate, complete Steps 2–4 and write the full authoring directory: provenance input, exactly one eval prompt source, `task.json`, `test.patch`, and `gold.patch`. If a candidate fails provenance, separability, equivalent-design, or reproducibility review while being authored, record the rejection and replace it with the next ranked candidate. Do not validate or audit any task until the full target batch has been authored; do not let an early task's result change which later candidates get created.
2. **Deterministic validation.** Once all `N` task directories exist, validate every task with the nop/oracle validator.
3. **Static audit.** Run `selfbench audit` over the batch.
4. **Independent coupling review.** Run `selfbench review-coupling <task-dirs> --provider <provider> --model <model>` over the batch. This sends only the eval prompt and the two held-out patches to a fresh model pass with no authoring context, and writes `coupling_review.json` into each task directory. Do not substitute your own judgment for this pass: you authored the tasks and cannot independently review them.
5. **Resolution pass.** Using the validation, audit, and coupling findings together: repair tasks where a finding is fixable (relax an over-tight assertion, extend `test.patch` with a helper the tests need, restore prompt wording that provenance supports), and replace tasks that cannot be repaired with the next ranked candidate. Any task whose prompt or patches changed must be revalidated and coupling-reviewed again. Repeat until every task in the batch is validated with a `clean` (or reviewed-and-justified `minor`) coupling verdict, or the viable pool is exhausted.
6. **Report the folder.** Finish with a summary listing every task directory, its validation result, audit verdict, and coupling verdict, plus rejected candidates and the reason for each.

Whenever a task is rejected or removed at any stage, move its directory into `tasks/rejected/` (keeping `task.json` with its `source_pr`) instead of deleting it, so later sessions do not retry the candidate. Do not start Harbor with a coding agent/model; solver trials are a separate operation that requires an explicit user request.

Common command templates include:

| Project | Setup | Test command |
|---|---|---|
| Python with uv | `uv sync --group dev --frozen` | `uv run pytest -q {tests}` |
| Go | `go build ./...` | `go test {tests}` |
| Bun | `bun install --frozen-lockfile` | `bun test {tests}` |
| npm | `npm ci` | `npm test -- {tests}` |

## Step 5: validate and statically audit

Run the gold validator after the full batch is authored and before any separately requested model rollouts:

```bash
selfbench validate tasks/<task> --repo <local-repo> --env docker
```

Acceptance requires all of the following:

- The fail-to-pass tests fail at the base.
- Pass-to-pass tests pass at the base.
- The gold patch applies cleanly.
- Fail-to-pass tests pass with the gold patch twice in succession. This catches obvious flakes but does not prove full determinism.
- Pass-to-pass tests still pass with the gold patch.

Rollouts seal the agent's network: while the coding agent works, only its model provider's API host is reachable. Without that seal agents clone the upstream repository or download the source pull request diff and copy the reference implementation instead of writing one, which silently invalidates every score. The verifier keeps normal egress because it reinstalls dependencies before running the held-out tests.

The validator uses separate Docker containers for the base and gold checks. A rollout uses the same two-container boundary: the agent container receives only the base snapshot and prompt, then its captured patch is graded in a separate verifier container with the held-out tests. Never place `gold.patch` or `test.patch` in the agent container, and never grade in a container that executed the agent.

If validation fails, correct the base commit, patch split, setup command, or test IDs. Do not weaken a legitimate test merely to make the task pass.

Run the static quality audit:

```bash
selfbench audit tasks/<task> --results results
```

Audit is independent of coding-model selection. Fix any blocker about gold-coupled private identifiers by replacing the test or rejecting the candidate.

## Separate operation: optionally run Harbor/model trials

Do not run coding models as part of task creation unless the user explicitly requests them. When solver signal is wanted, choose the provider/model set for that evaluation and run it separately:

```bash
uv run harbor run \
  --path harbor-tasks/TASK_ID \
  --agent pi \
  --model openai/gpt-5.6-sol \
  --agent-kwarg thinking=xhigh \
  --jobs-dir harbor-jobs \
  --allow-agent-host api.openai.com
```

Each rollout receives the resolved engineer prompt, edits a clean snapshot, and produces an agent patch. The grader removes held-out test edits, applies `test.patch`, and runs fail-to-pass plus pass-to-pass tests.

Harbor owns the job configuration, execution, and result artifacts under `harbor-jobs/`. Changing task inputs makes the compiled Harbor task stale, so rerun `selfbench validate` before interpreting new scores.

## Separate operation: review

The static audit may be rerun at any time:

```bash
selfbench audit tasks/<task> --results results
```

Do not open the review console automatically during `selfbench create`. When review is separately requested:

```bash
selfbench review --host 0.0.0.0 --port 8765 --tasks tasks --results results
```

Check the generated prompt against the human turns in Original Session when a source trace is attached. Then review the patch split and validation tails. If separate Harbor/model trials were run, also review their output and patches; generated-prompt rollouts must show a current prompt fingerprint before their solver signal is interpreted. Record any reviewed warnings and rationale in the review panel.

The final verdicts are:

- `accepted`: validation and static quality gates pass without unresolved warnings.
- `needs_review`: the task executes but has a static warning requiring judgment.
- `rejected`: validation or a blocking quality requirement fails.

Solver outcomes are reported separately and do not determine these quality verdicts.

## Quality rules

Reject or repair tasks with any of these defects:

- The prompt names held-out tests, new solution identifiers, patch files, or implementation steps.
- The test patch and gold patch overlap.
- Tests assert irrelevant internal structure rather than externally meaningful behavior.
- A test requires private names, fields, helpers, constants, intermediate payloads, sidecar filenames, archive layout, fixed byte offsets, or control flow introduced only by the gold patch. Equivalent implementations must be able to pass.
- The gold patch depends on a load-bearing dependency addition or upgrade that the prompt does not convey.
- The task has no authentic pre-implementation request provenance and was reconstructed from a PR description, implementation, or tests.
- The task omits essential context that an engineer had when receiving the request.
- The base already passes fail-to-pass tests.
- The gold implementation does not pass the selected tests deterministically.
- Pass-to-pass coverage is absent.

Keep private task material in the ignored `tasks/` directory. Do not commit source transcripts, proprietary patches, repository snapshots, or rollout results to the toolkit repository.
