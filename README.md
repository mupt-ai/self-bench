# self-bench

[![npm version](https://img.shields.io/npm/v/self-bench?color=blue&label=npm)](https://www.npmjs.com/package/self-bench)
[![CI](https://github.com/mupt-ai/self-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/mupt-ai/self-bench/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/mupt-ai/self-bench?color=green)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=000)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-3178c6?logo=typescript&logoColor=fff)](https://www.typescriptlang.org/)

**self-bench builds private coding-agent benchmarks from work already completed in your repository, so you can compare coding agents and models on tasks drawn from your own codebase.**

It finds completed requests from local coding sessions and merged GitHub pull requests, then reconstructs each task from the commit before the change. For every accepted task, self-bench creates hidden tests and a reference solution, proves that the task fails without a solution and passes with the original implementation, and exports a native task for [Harbor](https://harborframework.com/), a runner for coding-agent evaluations.

The result is a private `.tar.gz` benchmark that you can run against multiple models:

```text
Your repository history
        ↓
completed requests + implementations
        ↓
validated Harbor tasks with hidden tests
        ↓
gpt-5.6-luna vs gpt-5.6-terra vs gpt-5.6-sol
```

## Quickstart

This path runs the self-bench API, worker, and [Temporal](https://temporal.io/) workflow state locally while using [Modal](https://modal.com/) for disposable task-generation and validation sandboxes.

### Prerequisites

- [Bun](https://bun.sh/) 1.3.14 or newer
- Docker with Compose
- [Modal](https://modal.com/) CLI, account, and token (`pip install modal`)
- [`gh`](https://cli.github.com/), authenticated with read access to the repository
- An OpenAI API key with access to `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`
- A Git checkout with a GitHub `origin` and completed work in its history

Install self-bench and authenticate Modal and GitHub:

```bash
bun add --global self-bench
modal token new
gh auth login
```

Set the model and GitHub credentials used by the local worker, plus a random token that protects the local self-bench API:

```bash
export OPENAI_API_KEY=...
export GH_TOKEN="$(gh auth token)"
export SELFBENCH_API_TOKEN="$(openssl rand -hex 24)"
```

### 1. Start self-bench

```bash
self-bench up --backend modal
export SELFBENCH_API_URL=http://127.0.0.1:8080
```

This starts Postgres, Temporal, the self-bench API, and a worker in Docker. The worker sends sandbox work to Modal; `SELFBENCH_API_URL` tells subsequent CLI commands where to reach the local API.

### 2. Build a benchmark

```bash
self-bench run \
  --repo /absolute/path/to/your/repository \
  --easy-count 10 \
  --medium-count 10 \
  --hard-count 10 \
  --output ./self-bench-evals.tar.gz
```

Easy, medium, and hard candidates require at least 20, 50, and 100 changed implementation lines across 1, 2, and 3 paths respectively; the counts are generation budgets, not guarantees that every candidate will pass validation.

The repository must be a Git checkout with a GitHub `origin`. self-bench pins its current `HEAD`, ignores uncommitted changes, and may take hours to author, validate, review, and export the accepted tasks. `--output` waits for completion and verifies the downloaded archive with SHA-256.

### 3. Compare models with Harbor

Install Harbor and extract the generated tasks:

```bash
uv tool install --python 3.12 'harbor[modal]==0.20.1.dev202608040148'

mkdir -p ./self-bench-export ./self-bench-tasks
tar -xzf ./self-bench-evals.tar.gz -C ./self-bench-export
for archive in ./self-bench-export/tasks/*.tar.gz; do
  task_id="$(basename "$archive" .tar.gz)"
  mkdir -p "./self-bench-tasks/$task_id"
  tar -xzf "$archive" --strip-components=1 -C "./self-bench-tasks/$task_id"
done
```

Run Harbor's Codex agent adapter once for all three models. Harbor evaluates every extracted task at high reasoning and keeps the model results in one job directory:

```bash
harbor run \
  --path ./self-bench-tasks \
  --agent codex \
  --model gpt-5.6-luna \
  --model gpt-5.6-terra \
  --model gpt-5.6-sol \
  --ak version=0.146.1 \
  --ak reasoning_effort=high \
  --env modal \
  --jobs-dir ./harbor-jobs \
  --n-concurrent 20 \
  --yes
```

The evaluated agent receives the base repository and task instruction, but not the hidden tests or reference solution.

See [Running self-bench evaluations](docs/evaluations.md) for running one task and using the optional resumable matrix helper.

## Run management

Closing the waiting CLI does not cancel a submitted workflow. If the local worker or Docker stack stops, work pauses until the worker is restarted.

```bash
self-bench list                    # find run IDs
self-bench status RUN_ID
self-bench cancel RUN_ID
self-bench download RUN_ID ./self-bench-evals.tar.gz
```

Stop the local stack with:

```bash
self-bench down
```

Named Docker volumes retain Temporal history and generated artifacts.

## Other deployments

The quickstart is the recommended setup: a local stack with Modal sandboxes.

- **Local stack + Docker sandboxes:** use `self-bench up --backend docker` when you want all execution on your machine.
- **Local stack + Vercel Sandbox:** configure a Vercel project, access token, and digest-pinned VCR image, then explicitly choose Docker or Modal for Harbor validation.
- **Temporal Cloud + Modal:** use this for persistent unattended workers and large repositories.

See [Operations and deployment](docs/operations.md) for backend configuration, credentials, persistence, object storage, and the complete Temporal Cloud deployment.

Generation sandboxes and Harbor validation are independent choices. Docker and Modal retain their matching defaults; Vercel must name a Harbor environment because Harbor does not currently provide a Vercel environment:

```bash
# Matching defaults
self-bench up --backend docker
self-bench up --backend modal

# Vercel generation with either supported Harbor environment
self-bench up --backend vercel --harbor-environment docker
self-bench up --backend vercel --harbor-environment modal

# Explicit cross-provider combinations are also supported
self-bench up --backend docker --harbor-environment modal
self-bench up --backend modal --harbor-environment docker
```

Provider selection belongs to the worker, so all runs on one task queue use the same pairing. See [Vercel Sandbox setup](docs/operations.md#vercel-sandbox) for project authentication, publishing the runtime image, limits, cleanup, and troubleshooting.

## How tasks are validated

An accepted task must:

1. Preserve a real human request from repository history.
2. Start from the repository state before the completed change.
3. Include hidden tests that fail against the base snapshot.
4. Pass after applying the original implementation.
5. Survive deterministic reruns and an independent model review that rejects tests tied to private details of the reference solution.

Exports contain repository snapshots, hidden tests, and reference solutions. They are sensitive and unencrypted; keep them private.

See [Task construction and validation](docs/task-construction.md) for the full acceptance rules and archive format.

## Development

```bash
git clone https://github.com/mupt-ai/self-bench.git
cd self-bench
bun install --frozen-lockfile
bun run validate
```

Run the CLI directly from source:

```bash
bun run cli -- --help
```

Useful development commands:

```bash
bun run dev:api
bun run dev:worker
bun run dev:review
```

## Documentation

- [Task construction and validation](docs/task-construction.md)
- [Running evaluations](docs/evaluations.md)
- [Operations and deployment](docs/operations.md)

## License

[MIT](LICENSE) © 2026 Mupt AI.
