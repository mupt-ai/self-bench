# selfbench

Build private, SWE-bench-style evaluations from merged PRs in repositories you can clone. selfbench turns a completed change into a sealed task — original request, held-out tests, reference patch — then validates, audits, and reviews it before you spend a single model call grading agents on it.

[Harbor](https://harborframework.com) owns execution (agent and grading containers, Docker or Modal). selfbench owns task construction and quality control.

## How it works

```
selfbench create        # a Pi session discovers PRs and authors tasks
selfbench validate      # gold patch must pass its held-out tests, twice
selfbench audit         # static checks: separation, leakage, provenance
selfbench review-coupling  # independent model pass: can a *different*
                           # correct implementation still pass the tests?
selfbench run           # rollout: agent gets base commit + prompt only
selfbench report        # resolved-rate table across models
```

A task is two states of one real change. The agent container receives a history-free snapshot of the base commit and the engineer's original request — never the gold patch, test patch, or test names. Its patch is graded in a separate container against the held-out tests, with agent edits to protected test paths stripped first.

## Install

Requires Python 3.12+, [uv](https://docs.astral.sh/uv/), [Pi](https://github.com/earendil-works/pi) on the host, Docker or [Modal](https://modal.com) credentials for execution, the [GitHub CLI](https://cli.github.com) (`gh`) for PR discovery, and an API key for each model provider you use.

```bash
git clone https://github.com/mupt-ai/selfbench.git
cd selfbench
uv sync                    # add --extra modal to validate/run on Modal
bun install --frozen-lockfile   # only for the browser review console
```

Not published to PyPI; run everything with `uv run` from the checkout.

## Create tasks

```bash
uv run selfbench create --repo ~/code/your-project \
  --count 3 --provider openai --model gpt-5.6-sol --thinking high
```

This launches a Pi session with the bundled [task-building skill](skill/SKILL.md). It scans merged PRs, skips ones already attempted, requires authentic pre-implementation provenance (a coding session or linked issue — never a prompt reconstructed from the diff), splits implementation from tests, and writes task directories under `tasks/`:

```text
tasks/your-project-pr-123/
├── task.json     # selectors, metadata, provenance refs
├── prompt.md     # the request as the engineer originally posed it
├── test.patch    # held-out tests
└── gold.patch    # reference implementation
```

`--profile hard` opts into larger candidates: difficulty is judged on the separable implementation core that becomes `gold.patch` (roughly 100+ lines across 3+ files), not raw PR size, and the batch target counts *validated* tasks (15 per repo by default; `--count` overrides) — the create session runs the validation, audit, and coupling-review gates itself and replaces candidates that fail them. Omit `--profile` for the original behavior. To nominate a PR instead of autonomous discovery, add a message: `uv run selfbench create --repo ~/code/your-project "Build a task from PR 123."` When a task's prompt must be reconstructed from a private coding session, the separate `generate-prompt` command produces a standalone `prompt.md` from that session (see the skill for the rules it must follow).

## Gate tasks before spending rollouts

```bash
uv run selfbench validate tasks/your-project-pr-123 --repo ~/code/your-project
uv run selfbench audit tasks --results results
uv run selfbench review-coupling tasks --provider openai --model gpt-5.6-sol
```

- **validate** — two deterministic trials in separate containers: a *nop* run (no agent, unchanged base) and an *oracle* run (gold patch applied). The base must fail the task's *fail-to-pass* tests (the held-out tests the change is supposed to fix), the gold patch must fix them twice in a row, and the *pass-to-pass* tests (existing regression tests) must stay green throughout. Runs on Modal by default — pass `--env docker` if you only set up Docker. `validate-batch` does the same across many tasks concurrently.
- **audit** — static quality gates: patch separation, protected test paths, prompt leakage, gold-coupled identifiers, dependency-manifest coupling, provenance. Verdicts: `accepted` / `needs_review` / `rejected`; `--strict` for CI.
- **review-coupling** — sends only the prompt, both patches, and the graded test selectors to a fresh model pass with no authoring context, which classifies every name, signature, and output shape the tests rely on as prompt-derivable, guessable, or coupled. The verdict is written to `coupling_review.json` in the task directory, and a `coupled` verdict blocks the task in the audit. Prefer a different model than the one that authored the task.

A task that clears all three gates carries this guarantee: the reference implementation passes reproducibly, and an independent reviewer found no requirement that an equivalent-but-different implementation could not meet. That is "no known coupling after adversarial review," not a proof — re-run the gates whenever a prompt or patch changes (results are fingerprinted, so stale ones are flagged automatically).

## Run agents and read results

```bash
uv run selfbench run tasks/your-project-pr-123 --repo ~/code/your-project \
  --provider fireworks --model accounts/fireworks/models/kimi-k3 --thinking max

uv run selfbench report results --tasks tasks
```

Rollouts default to Docker (`--env modal` to fan out). Results land under `results/<task>/<provider>__<model>/` with fingerprints for the task, prompt, and patches; `report` prints a per-task, per-model resolved table and marks stale results. Provider keys are passed only to the agent process inside its container — use narrowly scoped keys.

## Export to plain Harbor

```bash
uv run selfbench build tasks/your-project-pr-123 --repo ~/code/your-project
uv run harbor run -p harbor-tasks/your-project-pr-123 \
  -a selfbench.harbor_pi:SelfbenchPi -m openai/gpt-5.6-sol
```

`build` compiles a task into a self-contained Harbor task directory (snapshot, verifier, oracle solution — no provenance or `task.json`). After that Harbor runs it directly; `-p` also accepts a directory of many tasks. Use the import-path agent shown above rather than Harbor's stock `-a pi`: the stock agent installs an outdated Pi npm package and lacks custom-router and full thinking-level support. Direct runs bypass the fingerprinted results index, so `report` and the audit will not see them.

## Review console

```bash
uv run selfbench review --tasks tasks --results results
```

A local web UI showing the resolved prompt, source-session provenance, patch views, validation output, and model outcomes, with a review queue (`J`/`K` navigation, status filters). Review decisions are saved into each task's `task.json`.

**What spends money:** `create`, `review-coupling`, `generate-prompt`, and `run` make model calls; `validate` runs containers (Modal or local Docker) but no model calls; `audit`, `report`, and `review` are free and local.

## Data handling

`tasks/` and `results/` are gitignored, but not everything stays local: validation and rollouts upload the base-commit snapshot to your execution environment, agents send the prompt and repository context to the configured model provider, and `generate-prompt` sends a redacted source conversation to a provider only after `--confirm-source-upload`. The gold and test patches never enter the agent container, but exported Harbor task directories necessarily contain them — treat exports like the answer key they are. Withholding the gold patch prevents harness leakage; it cannot prove a public change was absent from a model's training data.

## Development

```bash
uv run python -m unittest discover -s tests
bun run typecheck:review && bun run build:review
```

## License

No license file yet. Public visibility alone does not grant permission to copy, modify, or redistribute; an explicit license needs to be added before treating selfbench as open source.
