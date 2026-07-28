# selfbench

Turn changes from merged pull requests into executable SWE-bench-style coding-agent benchmarks. Each benchmark task is constructed manually from one completed change, then validated and run through selfbench's CLI. Each task gives a coding agent a clean repository snapshot and an engineer-authored work request, then grades the resulting patch with tests derived from the original change.

The toolkit validates task determinism, runs agent rollouts in isolated [Harbor](https://harborframework.com) Docker containers, audits benchmark quality, produces result tables, and includes a React review console for inspecting prompts, patches, and test output. Agent execution and grading use separate fresh containers so the agent cannot inspect held-out patches or persist ignored dependency state into grading.

Harbor owns the execution runtime. selfbench owns task construction, private-provenance audit, and the review queue. The compiled task format is a native Harbor task directory — sealed, self-contained, and runnable with `harbor run` directly.

## Install

Clone the repository and install dependencies. The CLI requires Python 3.12 or newer, [uv](https://docs.astral.sh/uv/), [Docker](https://www.docker.com/), and a local clone of the repository being benchmarked. The review console additionally requires [Bun](https://bun.sh/).

```bash
git clone https://github.com/mupt-ai/selfbench.git
cd selfbench
uv sync
bun install --frozen-lockfile
```

`uv sync` installs [Harbor](https://harborframework.com) (the execution runtime) as a Python dependency. Set the API key for the provider used by a rollout, such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. The CLI compiles a history-free archive of the selected base commit into a Harbor task directory, then Harbor runs the agent inside a Docker container. [Pi](https://github.com/earendil-works/pi) (a coding-agent CLI) is installed inside that container and invokes the selected model provider.

## Core concepts

A task compares two states of one change. The **base commit** is the repository state before the implementation. The **gold patch** is the completed implementation. The **test patch** supplies held-out tests that the coding agent cannot edit. **Fail-to-pass** selectors fail at the base and pass with the gold patch; **pass-to-pass** selectors already pass at the base and guard against regressions. A **rollout** is one model's attempt to solve the task from the engineer prompt.

## Create a task

Create a directory under `tasks/` with this shape:

```text
tasks/example-fix/
  task.json
  inputs/session.jsonl
  test.patch
  gold.patch
```

`test.patch` contains the tests that distinguish the broken base commit from the completed change. `gold.patch` contains the expected non-test implementation. `task.json` identifies the base commit, commands, and test cases:

```json
{
  "task_id": "example-fix",
  "repo": "example/project",
  "base_commit": "0123456789abcdef",
  "workdir": ".",
  "setup_cmd": "npm ci",
  "test_cmd": "npm test -- {tests}",
  "fail_to_pass": ["tests/regression.test.ts"],
  "pass_to_pass": ["tests/unit.test.ts", "tests/api.test.ts", "tests/cli.test.ts"],
  "test_paths": ["tests"],
  "prompt_source": {
    "path": "inputs/session.jsonl",
    "format": "codex",
    "message_index": 0
  }
}
```

`repo` is informational; `--repo` supplies the actual local clone at runtime. `workdir` is relative to that clone's root and is where setup and test commands run. `setup_cmd` is executed as a shell command. Each fail-to-pass or pass-to-pass entry is a framework-specific test selector passed as one shell-quoted argument at `{tests}`; it may be a file path, test name, or other selector accepted by the configured test command. `test_paths` contains repository-relative files or directories owned by the held-out test patch. Agent changes to those complete paths are excluded before grading.

`prompt_source` preserves the work request exactly as the engineer typed it. The path must stay inside the task directory. Supported formats are `codex`, `claude-code`, `pi`, and `generic`; use `auto` to detect the format. `message_index` is zero-based and may be negative, so `-1` selects the last engineer message in a session.

Codex extraction uses user-message events and ignores injected environment or instruction records. Claude Code extraction ignores tool-result user records. Pi extraction reads user message text blocks. The generic adapter accepts JSON or JSONL messages with `role: "user"` and string or text-block content.

For a task without an exported session, omit `prompt_source` and add a `prompt.md` file instead. A task must provide exactly one prompt source.

When a prompt must be reconstructed for standalone use but the original coding session is available, keep `prompt.md` and add a separate `trace_source` to `task.json`:

```json
{
  "trace_source": {
    "path": "inputs/session.jsonl",
    "format": "pi"
  }
}
```

`trace_source` is private generation provenance. It is not included in the eval prompt or uploaded with a rollout. The review console shows the original human turns by default and can reveal assistant context when needed. Injected instruction records and tool results are omitted, and common API-key patterns are redacted from the rendered trace.

Generate a standalone prompt from that conversation with:

```bash
uv run selfbench generate-prompt tasks/example-fix \
  --provider openai --model gpt-5.5 --thinking medium \
  --confirm-source-upload --write --force
```

The generator receives the redacted source conversation and basic repository context, but not the current prompt, gold patch, test patch, or held-out test names. Pi runs with tools, extensions, skills, project context files, and prompt templates disabled, so the generator cannot inspect the task directory or working tree. It preserves the human requester's framing and corrections while removing conversational logistics and implementation details. `--confirm-source-upload` is required because generation sends the private conversation to the configured model provider. Written prompts record their generator and content fingerprints in `task.json`.

The repository ignores `tasks/` by default so source patches and transcripts are not accidentally committed here. This is not a promise that evaluation data stays on one machine: the repository snapshot and prompt are bundled into the Harbor task directory, and relevant prompt or source content may be sent to the configured model provider. Apply your organization's data-handling rules before running proprietary tasks.

Task construction is a manual process: choose the base and completed commits, classify test versus implementation files, export the source coding-agent session, generate `test.patch` and `gold.patch`, and create `task.json`. The repository's [`skill/SKILL.md`](skill/SKILL.md) contains the complete authoring and review checklist.

Create each patch as a binary-safe Git diff from the base commit to the completed change. The two file lists must not overlap; if test and implementation changes cannot be separated by file, choose another task.

```bash
git -C ~/code/example-project diff --binary <base> <completed> -- <test-files...> \
  > tasks/example-fix/test.patch
git -C ~/code/example-project diff --binary <base> <completed> -- <implementation-files...> \
  > tasks/example-fix/gold.patch
```

## Validate and run

First prove that the selected tests fail at the base commit and pass with the gold implementation. Validation compiles the authoring task into a native Harbor task directory (under `harbor-tasks/`), then runs a **nop** (no-op agent) and an **oracle** (gold patch applied) trial in separate Docker containers:

```bash
uv run selfbench validate tasks/example-fix --repo ~/code/example-project
```

All six checks must pass:

- Base fails fail-to-pass tests
- Base passes pass-to-pass tests
- Gold patch applies cleanly
- Gold patch fixes fail-to-pass tests
- Gold patch fix is deterministic (passes twice in a row)
- Gold patch does not break pass-to-pass tests

Then run a real model. Pi is the default agent and supports providers such as `openai`, `anthropic`, `fireworks`, `google`, and `openrouter`. The agent container receives only the base snapshot and prompt. Its captured patch is collected by Harbor before the container shuts down, then graded in a separate verifier container that holds the test patch and runs the held-out tests; `gold.patch` is never placed in either rollout container:

```bash
uv run selfbench run tasks/example-fix --repo ~/code/example-project \
  --provider openai --model gpt-4.1 --thinking high
```

Results are written below `results/<task-id>/`. Each model gets a backward-compatible latest `result.json` and `agent.patch`, plus immutable history under `runs/<run-id>/`. Results record thinking effort, timestamps, harness/runtime versions, and fingerprints for the task definition, prompt, test patch, and gold patch. The generated agent patch excludes complete files under the held-out test paths before grading. If benchmark inputs or the result schema change, the audit and review console mark older validations and runs as stale until they are rerun.

Provider credentials are passed only to the Pi agent process inside the container. Pi and tool subprocesses it launches may still inherit those credentials, so use narrowly scoped evaluation keys. Setup and grading containers do not receive provider secrets.

## Build a Harbor task directly

The `build` subcommand compiles an authoring task into a native Harbor task directory without running a trial. Run validation separately before treating the task as usable benchmark signal. The output is a self-contained Harbor task runnable with any Harbor agent:

```bash
uv run selfbench build tasks/example-fix --repo ~/code/example-project
uv run harbor run -p harbor-tasks/example-fix -a pi -m openai/gpt-4.1
```

Generated task directories omit private provenance such as `task.json` and source-session transcripts. They contain the standard Harbor instruction, environment, oracle solution, and verifier layout. During a normal model rollout, Harbor exposes only the instruction and base repository environment to the agent; the oracle solution and held-out tests remain outside the agent container.

## Audit a benchmark

Validation proves that a task executes. The audit command checks whether it is also useful benchmark signal: the prompt must have authentic pre-implementation request provenance and be sufficiently specified without leaking held-out tests or solution identifiers, the test and implementation patches must be separated, held-out tests must not depend on exact identifiers introduced only by the gold patch, regression coverage must exist, and configured model outcomes must be present. By default the audit expects result directories named `openai__gpt-5.5` and `fireworks__glm-5p2`; override them with `--models`.

```bash
uv run selfbench audit tasks --results results
uv run selfbench report results --tasks tasks
```

Audit verdicts are computed automatically. `accepted` means the current validation and quality gates pass with mixed model outcomes. `needs_review` means the task executes but has a warning or inconclusive model signal. `rejected` means a blocking requirement fails, including a stale validation result. Without `--strict`, warnings and review-needed verdicts are reported without failing the command. Use `--strict` in automation when every task must be accepted.

The audit also surfaces fairness concerns that validation alone cannot catch. A task may execute deterministically and still be unsuitable for scoring if its held-out tests require exact private identifiers that only the gold patch introduces, assert on incidental implementation shape rather than observable behavior, or omit the main feature from the graded test selectors. When the audit or manual review finds such a problem, mark the task `changes_requested` in the review console and omit it from aggregate benchmark scores until it is repaired, revalidated, and rerun. The review status records that curation decision; it does not delete or rewrite existing results.

## Review tasks in the browser

Start the local review server:

```bash
uv run selfbench review --host 0.0.0.0 --port 8765 \
  --tasks tasks --results results
```

The command builds the Vite frontend when its sources change, then serves the React app and Python API together. The console shows the resolved eval prompt, the original source-session conversation when attached, task metadata, validation output, model outcomes, review notes, and interactive patch views. Use **Original Session** to compare a reconstructed prompt with what the engineer actually asked. Saving review notes updates the task's local `task.json` under its `quality` field.

The task list shows review status badges alongside audit verdicts. Use the status filter dropdown to group tasks by review status (`unreviewed`, `in_review`, `approved`, `changes_requested`, `rejected`) or by audit verdict. Keyboard shortcuts (`J` / `K`) and previous / next buttons navigate the queue. The current task and tab are persisted in the URL for deep linking.

For frontend development, run the API and Vite separately:

```bash
uv run selfbench review --port 8765 --tasks tasks --results results
bun run dev:review
```

Vite proxies `/api` requests to the Python server on port 8765.
Open the Vite URL printed by `bun run dev:review`; the Python server on port 8765 continues to provide the API.

## Checks

```bash
uv run python -m unittest discover -s tests -v
bun run typecheck:review
bun run build:review
```
