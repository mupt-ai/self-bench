# selfbench

Build private SWE-bench-style evaluations from real changes in repositories you can clone, then validate them, run coding-agent rollouts in isolated [Harbor](https://harborframework.com) Docker containers, and inspect the results in a browser.

Task construction remains a judgment-heavy workflow rather than deterministic PR import. `selfbench create` launches a [Pi](https://github.com/earendil-works/pi) session with the bundled task-building skill to scan merged pull requests, exclude previously attempted candidates, and choose viable changes itself. It then preserves the original engineering request, splits tests from implementation, and defines the test selectors. The toolkit makes the resulting task executable and checks whether it is fair, reproducible, and useful. You can also nominate a particular change or author a task by hand.

Harbor owns the execution runtime. selfbench owns task construction, private-provenance audit, and the review queue.

## What a task measures

A selfbench task contains two states of one completed change:

- The **base commit** is the repository before the implementation.
- The **gold patch** is the known-good implementation.
- The **test patch** contains held-out behavioral tests.
- **Fail-to-pass** selectors fail at the base and pass with the gold patch.
- **Pass-to-pass** selectors pass at the base and guard against regressions.
- The **prompt** preserves the engineer's original pre-implementation request.

During a rollout, the coding agent receives only a history-free archive of the base commit and the prompt. selfbench captures the agent's patch, starts a separate fresh grading container, applies the held-out tests there, removes agent edits to protected test paths, and runs the selected tests. Neither `gold.patch` nor `test.patch` is placed in the agent container.

## Install

You need Python 3.12+, [uv](https://docs.astral.sh/uv/), [Docker](https://www.docker.com/) (for local debugging), a local clone of the repository being benchmarked, and an API key for the model provider used by a rollout. Public validation on the default Modal environment also needs the `modal` extra (`uv sync --extra modal`) and Modal credentials ([Bun](https://bun.sh/) is required only for the review console).

```bash
git clone https://github.com/mupt-ai/selfbench.git
cd selfbench
uv sync
```

For the browser review console:

```bash
bun install --frozen-lockfile
```

`uv sync` installs Harbor (the execution runtime) as a Python dependency. Set the API key for the provider used by a rollout, such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENROUTER_API_KEY`. The CLI compiles a history-free archive of the selected base commit into a Harbor task directory, then Harbor runs the agent inside a Docker container. [Pi](https://github.com/earendil-works/pi) (a coding-agent CLI) is installed inside that container and invokes the selected model provider.

`selfbench create` also needs Pi installed on the host machine (the session that authors the task runs outside Docker).

## Create a task with the bundled skill

`selfbench create` launches a host Pi session with the bundled task-building skill. With no positional request, the agent inspects merged pull requests, excludes PRs already represented anywhere under the task root (including rejected candidates), ranks unseen changes, and builds the strongest viable task or tasks. It authors the full batch first, then may run deterministic nop/oracle validation and static quality audit. It never runs coding-agent/model solver trials unless explicitly requested; `selfbench run` and coding-model Harbor trials are separate operations. By default it opens an interactive Pi session; pass `--print` for one-shot creation.

```bash
# Let Pi discover and choose three merged PRs itself.
uv run selfbench create \
  --repo ~/code/example-project \
  --count 3 \
  --provider openai --model gpt-5.5 --thinking high

# Or nominate/scope candidates explicitly.
uv run selfbench create \
  --repo ~/code/example-project \
  "Build a task from PR 123."

# Opt in to harder candidates; the hard profile targets 15 validated
# tasks per repository by default (override with -n/--count).
uv run selfbench create \
  --repo ~/code/example-project \
  --profile hard \
  --provider openai --model gpt-5.5 --thinking high
```

Flags:

- `--repo <path>`: local clone of the repository being benchmarked (defaults to the current working directory).
- `-n, --count <number>`: target number of complete benchmark tasks to create; omitted means the agent chooses a reasonable batch size.
- `--profile <default|hard>`: candidate difficulty profile (default `default`, the existing behavior). `hard` shortlists larger merged PRs by changed-file and changed-line metadata (roughly 5+ files and 150+ changed lines), then ranks them by actual diff complexity and behavioral scope rather than size alone, skipping docs-only, formatting, dependency, generated-code, release, and broad-refactor changes. Difficulty is judged on the separable implementation core that becomes `gold.patch` (roughly 100+ lines across 3+ implementation files), not the PR envelope, so release-style bundles cannot masquerade as hard tasks. Its goal is a batch of tasks that pass deterministic validation — 15 per repository by default, or the `--count` value when supplied — so the agent replaces rejected or validation-failing candidates from the ranked list until the target validates or the viable pool is exhausted. All provenance, patch-separation, equivalent-design, and validation gates still apply; see the [task-building skill](skill/SKILL.md) for the full profile definition.
- `--tasks-root <dir>`: authoring task root (default `tasks`).
- `--provider`, `--model`, `--thinking`: Pi session options for the authoring agent.
- `--print`: non-interactive mode; process the prompt and exit.
- `--pi-executable <path>`: override the Pi executable (default `pi`).

Positional arguments are joined into the initial prompt. Omit them to run autonomous PR discovery; the interactive session remains open so you can steer it if needed. The agent should only ask for candidate selection when repository access, authentic request provenance, or another hard blocker prevents a safe choice. The skill instructs it to validate and audit completed tasks before spending rollout calls.

## Build a task manually

Choose a completed change with a reproducible behavioral requirement. Reject changes that require unavailable production services, secrets, nondeterministic external state, or tests that only accept the original implementation's private names and structure.

Create this directory shape under the ignored `tasks/` directory:

```text
tasks/example-fix/
├── task.json
├── inputs/session.jsonl  # preferred: the original coding session
├── test.patch            # held-out tests
└── gold.patch            # known-good implementation
```

If the completed change has cleanly separated test and implementation files, generate the two patches from the same commit range:

```bash
git -C ~/code/example-project diff --binary <base> <completed> \
  -- tests/regression.test.ts > tasks/example-fix/test.patch

git -C ~/code/example-project diff --binary <base> <completed> \
  -- src/feature.ts > tasks/example-fix/gold.patch
```

The patches must not touch the same file. `test_paths` must cover every path owned by `test.patch` so agent changes to those paths can be excluded before grading.

A minimal definition looks like this:

```json
{
  "task_id": "example-fix",
  "repo": "example/project",
  "base_commit": "0123456789abcdef",
  "workdir": ".",
  "setup_cmd": "npm ci",
  "test_cmd": "npm test -- {tests}",
  "fail_to_pass": ["tests/regression.test.ts"],
  "pass_to_pass": ["tests/unit.test.ts", "tests/api.test.ts"],
  "test_paths": ["tests"],
  "prompt_source": {
    "path": "inputs/session.jsonl",
    "format": "codex",
    "message_index": 0
  }
}
```

#### task.json field reference

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `task_id` | yes | string | Path-safe identifier (`[A-Za-z0-9._-]+`), used as the results directory name |
| `repo` | yes | string | Informational project slug (e.g. `"example/project"`); the actual clone is supplied by `--repo` at runtime |
| `base_commit` | yes | string | Full SHA of the commit the change was made against (first parent of the merge commit) |
| `workdir` | yes | string | Repo-relative working directory where commands run; `"."` for root |
| `setup_cmd` | yes | string | Shell command run before tests in each container |
| `test_cmd` | yes | string | Shell command containing `{tests}`; the placeholder is replaced with shell-quoted, framework-specific selectors |
| `fail_to_pass` | yes | string array | Test selectors that fail at the base with `test.patch` applied and pass with `gold.patch` applied |
| `pass_to_pass` | yes | string array | Test selectors that already pass at the base and must continue to pass |
| `test_paths` | yes | string array | Repo-relative files or directories owned by `test.patch`; agent edits below these paths are stripped before grading |
| `prompt_source` | no* | object | References the original coding session (`path`, `format`, `message_index`). Exactly one of `prompt_source` or `prompt.md` must exist |
| `trace_source` | no | object | Private generation provenance session (same shape as `prompt_source`); not used as the eval prompt |
| `source_pr` | no | integer | Original PR number for provenance tracking |
| `source_url` | no | string | URL to the original change for provenance tracking |
| `timeout_setup` | no | integer | Seconds to wait for `setup_cmd` (default 900) |
| `timeout_agent` | no | integer | Seconds to wait for the coding agent (default 2400) |
| `timeout_tests` | no | integer | Seconds to wait for `test_cmd` (default 900) |
| `network_mode` | no | string | Docker network mode: `public`, `no-network`, or `allowlist` (default `public`) |
| `cpus` | no | integer | CPU count for the agent container (default 4) |
| `memory_mb` | no | integer | Memory limit in MB for the agent container (default 8192) |
| `storage_mb` | no | integer | Storage limit in MB for the agent container (default 20480) |

`test_paths` entries are repo-root-relative directory prefixes; `"tests"` protects `tests/` and everything under it. Test selectors in `fail_to_pass` and `pass_to_pass` are passed to `test_cmd` as one shell-quoted argument each; how they map to specific tests depends on your test framework. The patches must not touch the same file. If the completed change modifies both implementation and test files in a single file (inline tests, Python docstring tests), the change is not suitable for a task under this toolkit.

`prompt_source` can extract user turns from Codex, Claude Code, Pi, or generic JSON/JSONL sessions. Without an exported session, omit `prompt_source` and write `prompt.md` instead. The task must use exactly one eval prompt source.

The bundled [task-building skill](skill/SKILL.md) is the end-to-end construction checklist, including candidate rejection criteria and prompt-provenance rules.

For a task whose prompt has been reconstructed from the original coding session, the `trace_source` field preserves the private source conversation while the standalone `prompt.md` contains the eval prompt. Generate the standalone prompt with:

```bash
uv run selfbench generate-prompt tasks/example-fix \
  --provider openai --model gpt-5.5 --thinking medium \
  --confirm-source-upload --write --force
```

The generator receives the redacted source conversation and basic repository context, but not the current prompt, gold patch, test patch, or held-out test names. `--confirm-source-upload` is required because generation sends the private conversation to the configured model provider.

## Validate before running a model

Validation compiles the authoring task into a native Harbor task directory (under `harbor-tasks/`), then runs a **nop** (no-op agent) and an **oracle** (gold patch applied) trial as a pair of Harbor trials. It runs on the [Modal](https://modal.com) environment by default so a whole public task set can fan out without contending for a single local Docker daemon; pass `--env docker` (or any other Harbor environment) to debug offline/local. Modal authentication and per-task errors are always surfaced, never hidden:

```bash
# Modal is the default environment.
uv run selfbench validate tasks/example-fix --repo ~/code/example-project

# Local/offline debugging on a single Docker daemon.
uv run selfbench validate tasks/example-fix --repo ~/code/example-project --env docker
```

> Modal is an opt-in dependency. Install it with `uv sync --extra modal` and
> authenticate with `modal token set` (Harbor also accepts `MODAL_TOKEN_ID` and
> `MODAL_TOKEN_SECRET`). Without the extra, `--env modal` fails immediately
> with a clear missing-SDK error rather than silently falling back to Docker.

### Validate many tasks at once

`selfbench validate-batch` validates every task under one or more task dirs
concurrently, skipping tasks that already have a current, valid result. It
also defaults to Modal, and by default it runs **all** tasks concurrently
(concurrency = task count); throttle with `--concurrency <n>` or the
`SELFBENCH_VALIDATION_CONCURRENCY` environment variable. Each task keeps its
own result and its own log under `--logs` so failures stay attributable:

```bash
# Run every task in tasks/ at once on Modal. Repos resolve as <repos-root>/<repo name>.
uv run selfbench validate-batch tasks \
  --repos-root ~/code --results results

# Throttled local validation with an explicit Docker override.
SELFBENCH_VALIDATION_CONCURRENCY=4 \
  uv run selfbench validate-batch tasks \
  --repos-root ~/code --env docker --results results

# A shell pass-through wrapper with the same defaults and env overrides.
scripts/validate-batch.sh tasks --repos-root ~/code
```

Six checks must all pass:

- Base fails fail-to-pass tests
- Base passes pass-to-pass tests
- Gold patch applies cleanly
- Gold patch fixes fail-to-pass tests
- Gold patch fix is deterministic (passes twice in a row)
- Gold patch does not break pass-to-pass tests

Run the quality audit before spending model calls:

```bash
uv run selfbench audit tasks/example-fix --results results
```

The audit checks prompt provenance, patch separation, protected test paths, likely solution leakage, gold-coupled private identifiers, regression coverage, validation freshness, and model outcome signal. A pre-rollout audit can legitimately report missing model signal; fix blockers before continuing.

The audit also surfaces fairness concerns that validation alone cannot catch. A task may execute deterministically and still be unsuitable for scoring if its held-out tests require exact private identifiers that only the gold patch introduces, assert on incidental implementation shape rather than observable behavior, or omit the main feature from the graded test selectors.

## Run and grade a coding agent

Pi is the default agent and supports providers such as `openai`, `anthropic`, `fireworks`, `google`, and `openrouter`. The agent container receives only the base snapshot and prompt. Its captured patch is collected by Harbor before the container shuts down, then graded in a separate verifier container that holds the test patch and runs the held-out tests; `gold.patch` is never placed in either rollout container:

```bash
uv run selfbench run tasks/example-fix --repo ~/code/example-project \
  --provider openai --model gpt-4.1 --thinking high
```

Results are written below `results/<task-id>/<provider>__<model>/`. The `result.json` and `agent.patch` at the top of that directory are the latest result; immutable run artifacts, including prior attempts, live under `runs/<run-id>/`. Results record thinking effort, timestamps, harness/runtime versions, and fingerprints for the task definition, prompt, test patch, and gold patch. If benchmark inputs or the result schema change, the audit and review console mark older validations and runs as stale until they are rerun.

Provider credentials are passed only to the Pi agent process inside the container. Pi and tool subprocesses it launches may still inherit those credentials, so use narrowly scoped evaluation keys. Setup and grading containers do not receive provider secrets.

## Build a Harbor task directly

The `build` subcommand compiles an authoring task into a native Harbor task directory without running a trial. Run validation separately before treating the task as usable benchmark signal:

```bash
uv run selfbench build tasks/example-fix --repo ~/code/example-project
uv run harbor run -p harbor-tasks/example-fix -a pi -m openai/gpt-4.1
```

Generated task directories omit private provenance such as `task.json` and source-session transcripts. They contain the standard Harbor instruction, environment, oracle solution, and verifier layout.

## Audit a benchmark suite

```bash
uv run selfbench audit tasks --results results
uv run selfbench report results --tasks tasks
```

Audit verdicts are:

- `accepted`: validation and static quality gates pass without unresolved warnings;
- `needs_review`: the task executes but has a static warning requiring judgment;
- `rejected`: a blocking quality requirement or current validation fails.

Use `--strict` when automation should fail unless every task is accepted. Audit does not require or select coding models. Run Harbor/model trials separately when you want solver signal. To display already-indexed model results as informational signal, pass their result-directory slugs explicitly with `--models`; those outcomes do not change the quality verdict.

## Review tasks in a browser

```bash
uv run selfbench review --host 0.0.0.0 --port 8765 \
  --tasks tasks --results results
```

The review console shows the resolved eval prompt, the original source-session conversation when attached, task metadata, validation output, model outcomes, review notes, and interactive patch views. Use **Original Session** to compare a reconstructed prompt with what the engineer actually asked. Saving review notes updates the task's local `task.json` under its `quality` field.

The task list shows review status badges alongside audit verdicts. Use the status filter dropdown to group tasks by review status (`unreviewed`, `in_review`, `approved`, `changes_requested`, `rejected`) or by audit verdict. Keyboard shortcuts (`J` / `K`) and previous / next buttons navigate the queue. The current task and tab are persisted in the URL for deep linking. When the audit or manual review finds a fairness concern, mark the task `changes_requested` to omit it from aggregate benchmark scores until it is repaired, revalidated, and rerun. The review status records that curation decision; it does not delete or rewrite existing results.

For frontend development, run the API and Vite separately:

```bash
uv run selfbench review --port 8765 --tasks tasks --results results
bun run dev:review
```

Vite proxies `/api` requests to the Python server on port 8765.

## Data handling

`tasks/` and `results/` are gitignored by default to reduce accidental commits, but they do not remain exclusively on your machine during normal use:

- validation and rollout compile a history-free archive of `base_commit` into a Harbor task directory that includes the repository snapshot;
- an agent rollout sends the prompt and relevant repository context to the configured model provider through Pi;
- `generate-prompt` sends a redacted source conversation to the selected provider only after `--confirm-source-upload`;
- the gold and test patches are kept out of the agent container, but validation and grading containers receive the patches required for their phase.

Apply your organization's source-code, transcript, and provider-key policies before benchmarking proprietary repositories. Withholding the gold patch prevents direct solution leakage from the harness; it does not prove that a public change was absent from a model's training data.

## Development

```bash
uv run python -m unittest discover -s tests -v
bun run typecheck:review
bun run build:review
```

## Licensing

This repository does not currently include a repository-wide license. Public visibility alone does not grant permission to copy, modify, or redistribute the code; add an explicit license before presenting selfbench as open-source software.
