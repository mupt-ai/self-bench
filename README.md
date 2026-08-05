# selfbench

[![CI](https://github.com/mupt-ai/selfbench/actions/workflows/ci.yml/badge.svg)](https://github.com/mupt-ai/selfbench/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/mupt-ai/selfbench/blob/main/LICENSE)

Selfbench turns completed repository changes—usually merged pull requests—into reproducible software-engineering evals for [Harbor](https://harborframework.com).

It recovers the original engineering request, separates the implementation from held-out tests, and checks that doing nothing fails while the known-good solution passes. Selfbench creates and validates evals; Harbor runs coding agents against them.

## Quick start

You need Python 3.12+, an authenticated [GitHub CLI](https://cli.github.com/), and an installed [Pi](https://github.com/earendil-works/pi) CLI. Use Docker for local validation or Modal for remote validation.

```bash
pip install selfbench
```

Create one eval from a local clone whose GitHub remote you can access:

```bash
selfbench create --repo ~/code/my-project --count 1 --print
```

Pi inspects merged pull requests, selects a viable change, writes the eval, validates it, and audits its provenance and test design. To target a specific change:

```bash
selfbench create --repo ~/code/my-project \
  "Create an eval from PR 123."
```

Creation writes authoring files to `tasks/TASK_ID` under your current directory. Validation generates the runnable Harbor task at `harbor-tasks/TASK_ID`.

## Validate

Validation defaults to Modal. Install its dependencies with `pip install "selfbench[modal]"`, or pass `--env docker` to run locally:

```bash
selfbench validate tasks/TASK_ID \
  --repo ~/code/my-project \
  --env docker
```

You can validate every eval directly below a task root with the same command:

```bash
selfbench validate tasks --repo ~/code/my-project --env docker
```

An eval is valid only when all six checks pass:

- the base fails the fail-to-pass tests;
- the base passes the regression tests;
- the gold patch applies cleanly;
- the gold patch fixes the fail-to-pass tests;
- the fix passes twice to catch obvious flakes;
- the gold patch preserves the regression tests.

Successful validation prints the generated Harbor path and exact command to use next.

## Run with Harbor

Harbor—not selfbench—owns coding-agent execution and result artifacts:

```bash
export OPENAI_API_KEY=...
harbor run \
  --path harbor-tasks/TASK_ID \
  --agent pi \
  --model openai/gpt-5.6-sol \
  --agent-kwarg thinking=xhigh \
  --jobs-dir harbor-jobs \
  --allow-agent-host api.openai.com
```

This uses Harbor's stock Pi agent. For an OpenAI-compatible endpoint, also export `OPENAI_BASE_URL`; Harbor forwards it with `OPENAI_API_KEY`. Harbor does not copy local Pi `models.json` or `auth.json` files into rollout sandboxes, so use a stock Pi provider or configure a supported provider through its environment variables. You can replace `pi` with any other agent supported by Harbor.

## What an eval contains

```text
tasks/<task-id>/
├── task.json
├── inputs/session.jsonl  # preferred source request
├── test.patch            # held-out behavioral tests
└── gold.patch            # known-good implementation
```

The coding agent receives a history-free snapshot of the base commit and the engineering request. Harbor grades its patch separately with the held-out tests. The agent never receives `gold.patch` or `test.patch`.

See [Authoring evals](https://github.com/mupt-ai/selfbench/blob/main/docs/authoring-evals.md) for the task schema, manual authoring, provenance rules, and rejection criteria. The bundled [selfbench skill](https://github.com/mupt-ai/selfbench/blob/main/skill/SKILL.md) contains the complete construction checklist.

## Audit and review

```bash
selfbench audit tasks --results results --strict
selfbench review-coupling tasks/TASK_ID \
  --provider openai --model gpt-5.6-sol
```

For provenance and patch review, open the local review console:

```bash
bun install --frozen-lockfile
bun run build:review
selfbench review --tasks tasks --results results
```

## Data handling

`tasks/`, `results/`, `harbor-tasks/`, and `harbor-jobs/` are gitignored. They may contain proprietary code, source conversations, patches, and model outputs. Apply your organization's source-code, transcript, and provider-key policies before using private repositories.

## Development

```bash
uv sync --locked
bun install --frozen-lockfile
bun run validate
```

`bun run validate` runs the Python tests, review-console typecheck, and production build—the same checks used by CI.

## License

MIT. See [LICENSE](https://github.com/mupt-ai/selfbench/blob/main/LICENSE).
