# SelfBench

SelfBench turns completed GitHub changes into private [Harbor](https://harborframework.com/) evaluations for coding agents.

It finds real feature requests, builds a task from the repository's base commit, hides the tests and reference solution, and validates that the task fails without a solution and passes with one.

## Quickstart: make an eval from a repository

You need Docker (8 GB RAM and 20 GB free), Node.js 22+, Bun 1.3.14+, `gh`, Pi, and Codex CLI. Authenticate first:

```bash
gh auth login
# In Pi: /login -> OpenAI Codex
codex login
```

Clone SelfBench and build it:

```bash
git clone https://github.com/mupt-ai/self-bench.git
cd self-bench
npm install -g @earendil-works/pi-coding-agent@0.84.0
bun install --frozen-lockfile
bun run build
```

Start the local stack:

```bash
export SELFBENCH_API_TOKEN="$(openssl rand -hex 24)"
export GH_TOKEN="$(gh auth token)"
node dist/cli.js up
until curl --fail http://127.0.0.1:8080/healthz; do sleep 2; done
```

Now point SelfBench at **your checked-out repository**. It uses the repo's `origin` URL and current `HEAD`, then discovers eligible completed changes from local coding sessions and merged GitHub pull requests:

```bash
export SELFBENCH_API_URL=http://127.0.0.1:8080

node dist/cli.js run \
  --repo /absolute/path/to/your/repository \
  --easy-count 1 \
  --output ./my-evals.tar.gz
```

`my-evals.tar.gz` contains the accepted Harbor tasks. `--easy-count 1` is one candidate-generation attempt, **not** a guarantee that one task will be accepted. Rejected candidates are not replaced. Use `--medium-count` or `--hard-count` for the other tiers.

The repository must be a Git checkout with a GitHub `origin`, and SelfBench must find at least one usable local request or merged non-bot pull request. Uncommitted changes are ignored.

## What happens next?

Run an agent against an extracted task with Harbor, or evaluate a whole export with the included matrix runner. See [Running evaluations](docs/evaluations.md).

For the validation contract and task format, see [task construction](docs/task-construction.md). For credentials, Modal, persistence, and deployment, see [operations](docs/operations.md).

## Commands

```bash
node dist/cli.js status RUN_ID
node dist/cli.js list
node dist/cli.js cancel RUN_ID
node dist/cli.js download RUN_ID ./my-evals.tar.gz
```

`--output` waits for completion and verifies the downloaded archive's SHA-256. Runs can take hours because every candidate is authored, audited, sandbox-validated, and independently reviewed.

## Development

```bash
bun install --frozen-lockfile
bun run validate
```

## License

[MIT](LICENSE) © 2026 Mupt AI.
