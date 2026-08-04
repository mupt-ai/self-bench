# selfbench

Build private, SWE-bench-style evaluations from merged PRs in repositories you can clone. A task pairs the engineer's original request with the held-out tests from their change; the agent gets a history-free checkout and the request, nothing else. [Harbor](https://harborframework.com) runs the containers; selfbench builds the tasks and gates their quality.

## Install

Needs Python 3.12+, [uv](https://docs.astral.sh/uv/), [Pi](https://github.com/earendil-works/pi), Docker (or [Modal](https://modal.com) credentials), [`gh`](https://cli.github.com) for PR discovery, and a provider API key.

```bash
git clone https://github.com/mupt-ai/selfbench.git && cd selfbench
uv sync                          # --extra modal to run on Modal
bun install --frozen-lockfile    # only for the review console
```

Not on PyPI — run everything with `uv run` from the checkout.

## Quickstart

One task, end to end, against any GitHub repo you have cloned. Check prerequisites with `pi --version && gh auth status && docker info`; `pi --list-models` lists usable provider/model pairs.

```bash
# 1. Author. The Pi session picks a merged PR and names the directory
#    it created in its summary — substitute that path below.
uv run selfbench create --repo ~/code/your-project -n 1 \
  --provider openai --model gpt-5.6-sol --thinking high

# 2. Gate.
uv run selfbench validate tasks/your-project-pr-123 --repo ~/code/your-project --env docker
uv run selfbench audit tasks --results results
uv run selfbench review-coupling tasks/your-project-pr-123 --provider openai --model gpt-5.6-sol

# 3. Benchmark an agent and read the score.
uv run selfbench run tasks/your-project-pr-123 --repo ~/code/your-project \
  --provider openai --model gpt-5.6-sol
uv run selfbench report results --tasks tasks
```

Step 1 is judgment-heavy: the session rejects PRs that lack authentic pre-implementation provenance or separable tests, which is the point. If it finds no candidate, nominate one — append `"Build a task from PR 123."` to the create command.

## What a task is

```text
tasks/your-project-pr-123/
├── task.json     # test selectors, metadata, provenance refs
├── prompt.md     # the request as the engineer originally posed it
├── test.patch    # held-out tests
└── gold.patch    # reference implementation
```

Authored by a Pi session running the bundled [task-building skill](skill/SKILL.md), which owns the rules: provenance must predate the implementation, tests and implementation must split cleanly by file, and held-out tests must be passable by an equivalent-but-different implementation. `--profile hard` targets larger changes, judging difficulty on the extracted `gold.patch` core (~100+ lines across 3+ files) rather than raw PR size.

During a rollout the agent's network is sealed to its model provider's API host — otherwise agents clone the upstream repo or fetch the PR diff and copy the answer instead of writing one.

## The three gates

- **validate** — a *nop* trial (unchanged base) and an *oracle* trial (gold patch applied) in separate containers. Base must fail the fail-to-pass tests, gold must fix them twice running, and the pass-to-pass regression tests must stay green. Defaults to Modal; `--env docker` for local. `validate-batch` runs many concurrently.
- **audit** — static checks: patch separation, protected test paths, prompt leakage, gold-coupled identifiers, dependency coupling, provenance. Verdicts `accepted` / `needs_review` / `rejected`, with `--strict` for CI.
- **review-coupling** — a fresh model pass seeing only the prompt, both patches, and the graded selectors, which classifies everything the tests rely on as prompt-derivable, guessable, or coupled. A `coupled` verdict blocks the task. Use a different model than the one that authored it.

Clearing all three means: the reference implementation passes reproducibly, and an independent reviewer found nothing an equivalent implementation couldn't satisfy. That is "no known coupling after adversarial review," not a proof. Results are fingerprinted, so edits mark them stale — re-run the gates.

**Cost:** `create`, `review-coupling`, `generate-prompt`, and `run` make model calls. `validate` runs containers but no model calls. `audit`, `report`, and `review` are free and local.

## Running many tasks

Results land in `results/<task>/<provider>__<model>/`, and `report` prints a per-task, per-model resolved table marking stale rows. For a large one-shot batch, compile tasks into a dataset and let Harbor fan out instead:

```bash
uv run selfbench build tasks/your-project-pr-123 --repo ~/code/your-project \
  --harbor-tasks harbor-dataset
uv run harbor run -p harbor-dataset -a selfbench.harbor_pi:SelfbenchPi \
  -m openai/gpt-5.6-sol --env modal -n 20 --allow-agent-host api.openai.com
```

`-p` accepts a directory of many compiled tasks; Harbor handles concurrency and retries. Use the import-path agent rather than stock `-a pi`, which installs an outdated Pi. Direct Harbor runs bypass the fingerprinted results index, so `report` and the audit won't see them.

## Review console

```bash
uv run selfbench review --tasks tasks --results results
```

Local web UI for the resolved prompt, provenance, patch views, validation output, and model outcomes, with a review queue (`J`/`K`, status filters). Decisions save into `task.json`.

## Data handling

`tasks/` and `results/` are gitignored, but nothing here is airtight: validation and rollouts upload the base-commit snapshot to your execution environment, agents send the prompt and repository context to the model provider, and `generate-prompt` uploads a redacted source conversation only after `--confirm-source-upload`. Gold and test patches never enter the agent container — but exported Harbor task directories contain them, so treat exports as the answer key. Withholding the gold patch prevents harness leakage; it cannot prove a public change was absent from a model's training data.

## Development

```bash
uv run python -m unittest discover -s tests
bun run typecheck:review && bun run build:review
```

## License

No license file yet. Public visibility alone does not grant permission to copy, modify, or redistribute.
