# selfbench

Build private SWE-bench-style evaluations from real changes in repositories you can clone, then validate them, run coding-agent rollouts in isolated sandboxes, and inspect the results in a browser.

Task construction is currently manual. selfbench does not import a pull request or infer the benchmark for you: you choose the base and completed commits, preserve the original engineering request, split tests from implementation, and define the test selectors. The toolkit makes that task executable and checks whether it is fair, reproducible, and useful.

## What a task measures

A selfbench task contains two states of one completed change:

- The **base commit** is the repository before the implementation.
- The **gold patch** is the known-good implementation.
- The **test patch** contains held-out behavioral tests.
- **Fail-to-pass** selectors fail at the base and pass with the gold patch.
- **Pass-to-pass** selectors pass at the base and guard against regressions.
- The **prompt** preserves the engineer's original pre-implementation request.

During a rollout, the coding agent receives only a history-free archive of the base commit and the prompt. selfbench captures the agent's patch, starts a separate fresh grading sandbox, applies the held-out tests there, removes agent edits to protected test paths, and runs the selected tests. Neither `gold.patch` nor `test.patch` is uploaded to the agent sandbox.

## Install

You need Python 3.12+, [uv](https://docs.astral.sh/uv/), a [Modal](https://modal.com/) account, a local clone of the repository being benchmarked, and an API key for the model provider used by a rollout. [Bun](https://bun.sh/) is required only for the review console.

```bash
git clone https://github.com/mupt-ai/selfbench.git
cd selfbench
uv sync --frozen
uv run modal setup
```

For the browser review console:

```bash
bun install --frozen-lockfile
```

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
| `setup_cmd` | yes | string | Shell command run before tests in each sandbox |
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

`test_paths` entries are repo-root-relative directory prefixes; `"tests"` protects `tests/` and everything under it. Test selectors in `fail_to_pass` and `pass_to_pass` are passed to `test_cmd` as one shell-quoted argument each; how they map to specific tests depends on your test framework. The patches must not touch the same file. If the completed change modifies both implementation and test files in a single file (inline tests, Python docstring tests), the change is not suitable for a task under this toolkit.

`prompt_source` can extract user turns from Codex, Claude Code, Pi, or generic JSON/JSONL sessions. Without an exported session, omit `prompt_source` and write `prompt.md` instead. The task must use exactly one eval prompt source.

The bundled [task-building skill](skill/SKILL.md) is the end-to-end construction checklist, including candidate rejection criteria and prompt-provenance rules.

## Validate before running a model

Validation uses separate fresh Modal sandboxes to prove that the held-out tests expose the intended change:

```bash
uv run selfbench validate tasks/example-fix \
  --repo ~/code/example-project
```

A valid task requires:

1. fail-to-pass selectors fail against the base with the test patch;
2. pass-to-pass selectors pass at the base;
3. the gold and test patches apply cleanly;
4. all selected tests pass with the gold implementation, including a second fail-to-pass run to catch obvious flakes.

Run the quality audit before spending model calls:

```bash
uv run selfbench audit tasks/example-fix --results results
```

The audit checks prompt provenance, patch separation, protected test paths, likely solution leakage, gold-coupled private identifiers, regression coverage, validation freshness, and model outcome signal. A pre-rollout audit can legitimately report missing model signal; fix blockers before continuing.

## Run and grade a coding agent

```bash
uv run selfbench run tasks/example-fix \
  --repo ~/code/example-project \
  --provider openai \
  --model gpt-5.5
```

selfbench installs Pi inside a fresh Modal sandbox. Pi receives the base snapshot and resolved prompt, invokes the selected model provider, edits the repository, and produces a patch. A new grading sandbox applies that patch plus the held-out tests and reports whether fail-to-pass and pass-to-pass selectors succeed.

Results are written below `results/<task-id>/<provider>__<model>/`. The `result.json` and `agent.patch` at the top of that directory are the latest result; immutable run artifacts, including prior attempts, live under `runs/<run-id>/`. Result fingerprints become stale when the task, prompt, patches, or result schema change.

The default audit expects at least two model runs (`openai__gpt-5.5` and `fireworks__glm-5p2`) for solver-signal analysis. Override this list with `--models`.

Provider credentials are scoped to the Pi command rather than setup and grading commands. Pi and any tools it launches can still inherit those credentials, so use narrowly scoped evaluation keys.

## Audit a benchmark suite

```bash
uv run selfbench audit tasks --results results
uv run selfbench report results --tasks tasks
```

Audit verdicts are:

- `accepted`: validation and quality gates pass, with mixed outcomes across the expected model ladder;
- `needs_review`: the task executes but has a warning or inconclusive solver signal;
- `rejected`: a blocking quality requirement or current validation fails.

Use `--strict` when automation should fail unless every task is accepted.

## Review tasks in a browser

```bash
uv run selfbench review \
  --host 127.0.0.1 \
  --port 8765 \
  --tasks tasks \
  --results results
```

The review console shows the resolved prompt, attached source conversation, task metadata, validation output, model outcomes, notes, and side-by-side patches. It builds the Vite frontend when needed and serves the UI and Python API together.

## Data handling

`tasks/` and `results/` are gitignored by default to reduce accidental commits, but they do not remain exclusively on your machine during normal use:

- validation and rollout upload a history-free archive of `base_commit` to your Modal workspace;
- an agent rollout sends the prompt and relevant repository context to the configured model provider through Pi;
- `generate-prompt` sends a redacted source conversation to the selected provider only after `--confirm-source-upload`;
- the gold and test patches are kept out of the agent sandbox, but validation and grading sandboxes receive the patches required for their phase.

Apply your organization's source-code, transcript, and provider-key policies before benchmarking proprietary repositories. Withholding the gold patch prevents direct solution leakage from the harness; it does not prove that a public change was absent from a model's training data.

## Development

```bash
uv run python -m unittest discover -s tests -v
bun run typecheck:review
bun run build:review
```

## Licensing

This repository does not currently include a repository-wide license. Public visibility alone does not grant permission to copy, modify, or redistribute the code; add an explicit license before presenting selfbench as open-source software.
