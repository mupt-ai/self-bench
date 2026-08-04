# selfbench

[![CI](https://github.com/mupt-ai/selfbench/actions/workflows/ci.yml/badge.svg)](https://github.com/mupt-ai/selfbench/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Selfbench turns completed repository changes—usually merged pull requests—into reproducible software-engineering evals for [Harbor](https://harborframework.com), a framework for running coding agents in isolated environments.

It recovers an authentic pre-implementation request from a coding session, issue, or ticket; separates the implementation from held-out tests; and checks that doing nothing fails while the known-good solution passes. Selfbench creates and validates evals; Harbor runs coding agents against them.

Automated discovery targets merged GitHub pull requests. You can also [author an eval manually](docs/authoring-evals.md) from another completed commit.

## Quick start

You need Python 3.12+, [uv](https://docs.astral.sh/uv/), Docker, an authenticated [GitHub CLI](https://cli.github.com/), and an installed [Pi](https://github.com/earendil-works/pi) CLI authenticated with the model provider used for authoring.

```bash
git clone https://github.com/mupt-ai/selfbench.git
cd selfbench
uv sync --locked
```

`uv sync` installs the supported Harbor version with selfbench.

Create one eval from a repository you can clone:

```bash
uv run selfbench create --repo ~/code/my-project --count 1 --print
```

Pi uses GitHub CLI and the bundled authoring checklist to inspect merged pull requests not already represented under `tasks/`, select a viable change, write the eval, validate it, and audit its provenance, patch separation, leakage, and test design. Pass a free-form instruction to Pi after the options to target a specific change; that instruction selects the source change, while the authentic request recovered from the coding session, issue, or ticket becomes the eval prompt.

```bash
uv run selfbench create --repo ~/code/my-project \
  "Create an eval from PR 123."
```

Creation writes the authoring files to `tasks/TASK_ID`; the directory name is the task ID. Validation then generates a native Harbor task at `harbor-tasks/TASK_ID` and runs the no-op and known-good checks. Run the finished eval with Harbor—not selfbench:

```bash
export OPENAI_API_KEY=...
uv run harbor run \
  --path harbor-tasks/TASK_ID \
  --agent selfbench.harbor_pi:SelfbenchPi \
  --model openai/gpt-4.1 \
  --jobs-dir harbor-jobs
```

For another provider, set its API key and change the `provider/model` value. `SelfbenchPi` is a Harbor agent adapter for the maintained Pi package; you can replace it with another agent supported by Harbor. Harbor owns the job configuration, execution, and results under `harbor-jobs/`.

## Validate after editing

Validate one eval or every eval directly below a task root:

```bash
uv run selfbench validate tasks/TASK_ID --repo ~/code/my-project
uv run selfbench validate tasks --repo ~/code/my-project
```

An eval is valid only when all six checks pass:

- the base fails the fail-to-pass tests;
- the base passes the regression tests;
- the gold patch applies cleanly;
- the gold patch fixes the fail-to-pass tests;
- the fix passes a second time to catch obvious flakes;
- the gold patch preserves the regression tests.

Successful validation prints the task ID, generated Harbor path, and exact `harbor run` command to use next. Selfbench records the six check outcomes and task fingerprints under `results/`; coding-agent results belong to Harbor under `harbor-jobs/`.

## What an eval contains

```text
tasks/<task-id>/
├── task.json
├── inputs/session.jsonl  # preferred source request
├── test.patch            # held-out behavioral tests
└── gold.patch            # known-good implementation
```

The base commit is the repository state immediately before the source change. The coding agent receives that state without later Git history—which could leak the solution—plus the engineering request. Harbor grades the agent's patch in a separate verifier environment with the held-out tests. The agent environment never receives `gold.patch` or `test.patch`.

See [Authoring evals](docs/authoring-evals.md) for the task schema, manual authoring, provenance rules, and rejection criteria. The bundled [selfbench skill](skill/SKILL.md) contains the complete construction checklist.

## Audit and review

Run the static quality gates:

```bash
uv run selfbench audit tasks --results results --strict
```

For provenance and patch review, build and open the local review console:

```bash
bun install --frozen-lockfile
bun run build:review
uv run selfbench review --tasks tasks --results results
```

## Data handling

`tasks/`, `results/`, `harbor-tasks/`, and `harbor-jobs/` are gitignored. They may still contain proprietary code, source conversations, patches, and model outputs.

Harbor sends the prompt and relevant repository context to the configured model provider during a coding-agent run. The optional `generate-prompt --confirm-source-upload` workflow can also upload the original coding-session transcript to the selected model provider. Apply your organization's source-code, transcript, and provider-key policies before using private repositories.

## Development

```bash
uv sync --locked
bun install --frozen-lockfile
bun run validate
```

`bun run validate` runs the Python tests, review-console typecheck, and production frontend build—the same checks used by CI.

## License

MIT. See [LICENSE](LICENSE).
