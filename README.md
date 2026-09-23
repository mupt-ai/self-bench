# self-bench

[![npm version](https://img.shields.io/npm/v/self-bench?color=blue&label=npm)](https://www.npmjs.com/package/self-bench)
[![CI](https://github.com/mupt-ai/self-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/mupt-ai/self-bench/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/mupt-ai/self-bench?color=green)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=000)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-3178c6?logo=typescript&logoColor=fff)](https://www.typescriptlang.org/)

**self-bench builds private coding-agent benchmarks from work already completed in your repository, so you can compare coding agents and models on tasks drawn from your own codebase.**

It takes the requests behind merged GitHub pull requests, then reconstructs each task from the commit before the change. For every accepted task, self-bench creates hidden tests and a reference solution, proves that the task fails without a solution and passes with the original implementation, and exports a native task for [Harbor](https://harborframework.com/), a runner for coding-agent evaluations.

SelfBench is sandbox-agnostic: run generation locally with Docker or on Modal, Vercel Sandbox, or E2B. Generation and Harbor validation are configured independently, so Modal is optional.

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

This path runs the self-bench API, worker, [Temporal](https://temporal.io/), and all generation and validation sandboxes locally with Docker. It does not require an account with a hosted sandbox provider.

### Prerequisites

- [Bun](https://bun.sh/) 1.3.14 or newer
- [uv](https://docs.astral.sh/uv/) for installing Harbor
- Docker with Compose
- A GitHub OAuth app for sign-in (see [Site sign-in](docs/operations.md#site-sign-in-selfbenchdev))
- An OpenAI API key with access to `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`
- A GitHub repository with merged pull requests to author tasks from

Install the self-bench command, which wraps the run API, and set a random token that protects the local self-bench API:

```bash
bun add --global self-bench
export SELFBENCH_API_TOKEN="$(openssl rand -hex 24)"
```

Set `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, and `SELFBENCH_SESSION_SECRET` in `.env` so the API serves the signed-in site.

Model access for generation comes from managed platform keys or stored organization credentials (see [Credentials](docs/operations.md#credentials)); copy `.env.example` to `.env` and set `SELFBENCH_MANAGED_OPENROUTER_API_KEY` and `SELFBENCH_MANAGED_E2B_API_KEY` to use the platform's accounts.

### 1. Start self-bench

```bash
docker compose --profile sandbox up -d --build
export SELFBENCH_API_URL="http://$(docker compose port api 8080)"
```

This starts Postgres, Temporal, the self-bench API, and a worker, and builds the local sandbox image. The worker creates disposable local Docker sandboxes; `SELFBENCH_API_URL` tells the `self-bench` command where to reach the local API. Compose names the project after the checkout directory and publishes ephemeral host ports, so several worktrees run side by side (see [Operations](docs/operations.md#local-stack)). Existing volumes from the old `selfbench` project name keep working with `COMPOSE_PROJECT_NAME=selfbench docker compose --profile sandbox up -d --build`. Set `SELFBENCH_PUBLIC_URL` to the tunnel origin before `up` when serving the signed-in site.

### 2. Build a benchmark

Open the site at `SELFBENCH_PUBLIC_URL`, sign in with GitHub, connect a repository, and start a batch with easy, medium, and hard counts. self-bench authors tasks from the repository's merged pull requests; a batch may take hours to author, validate, review, and export. Then download the export, which the command verifies with SHA-256:

```bash
self-bench list
self-bench download RUN_ID ./self-bench-evals.tar.gz
```

Easy, medium, and hard candidates require at least 20, 50, and 100 changed implementation lines across 1, 2, and 3 paths respectively; the counts are generation budgets, not guarantees that every candidate will pass validation.

### 3. Evaluate with Harbor

Install Harbor and extract the generated tasks:

```bash
uv tool install --python 3.12 'harbor==0.23.0'

mkdir -p ./self-bench-export ./self-bench-tasks
tar -xzf ./self-bench-evals.tar.gz -C ./self-bench-export
for archive in ./self-bench-export/tasks/*.tar.gz; do
  task_id="$(basename "$archive" .tar.gz)"
  mkdir -p "./self-bench-tasks/$task_id"
  tar -xzf "$archive" --strip-components=1 -C "./self-bench-tasks/$task_id"
done
```

Run Harbor's Codex agent adapter directly. Harbor evaluates every extracted task at high reasoning and keeps the model results in one job directory. Repeat with additional `--model` values when comparing models:

```bash
harbor run \
  --path ./self-bench-tasks \
  --agent codex \
  --model gpt-5.6-luna \
  --model gpt-5.6-terra \
  --model gpt-5.6-sol \
  --ak version=0.146.1 \
  --ak reasoning_effort=high \
  --env docker \
  --jobs-dir ./harbor-jobs \
  --n-concurrent 1 \
  --yes
```

The evaluated agent receives the base repository and task instruction, but not the hidden tests or reference solution.

See [Running self-bench evaluations](docs/evaluations.md) for running tasks directly with Harbor.

The signed-in site also supports repository-scoped solver runs with live output and completed results. See [Run tasks from the site](docs/solver-evaluations.md) for worker configuration and supported choices.

## Run management

Batches keep running on the worker after you close the site. If the local worker or Docker stack stops, work pauses until the worker is restarted.

```bash
self-bench list                    # find run IDs
self-bench status RUN_ID
self-bench cancel RUN_ID
self-bench download RUN_ID ./self-bench-evals.tar.gz
```

Stop the local stack with:

```bash
docker compose down
```

Named Docker volumes retain Temporal history and generated artifacts.

## Choose a sandbox backend

The quickstart uses local Docker sandboxes so it works without a hosted sandbox account. For more concurrency or unattended runs, generation can use Modal, Vercel Sandbox, or E2B instead. Set the pairing in `.env` (or the shell) and start Compose:

- **Docker:** `SELFBENCH_EXECUTION_BACKEND=docker` keeps generation and validation on your machine. Include `--profile sandbox` so Compose builds the sandbox image.
- **Modal:** authenticate with `modal token new`, then set `SELFBENCH_EXECUTION_BACKEND=modal`.
- **Vercel Sandbox:** publish the runtime image ([steps](docs/operations.md#publish-the-runtime-image)) and export `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, and `SELFBENCH_VERCEL_IMAGE`; Harbor validation defaults to Vercel too.
- **E2B:** the worker builds the pinned SelfBench runtime template on first use, or build one with `bun scripts/build-e2b-template.ts --name NAME[:TAG]`; Harbor validation defaults to E2B too.
- **Temporal Cloud + Modal/E2B:** use a persistent worker for unattended runs and large repositories.

See [Operations and deployment](docs/operations.md) for provider setup, credentials, persistence, object storage, and Temporal Cloud deployment.

Generation sandboxes and Harbor validation are independent choices. Every generation backend defaults to the matching Harbor environment, and `SELFBENCH_HARBOR_ENVIRONMENT` picks a different one. Daytona is available for Harbor only:

```bash
# Matching defaults
SELFBENCH_EXECUTION_BACKEND=docker docker compose --profile sandbox up -d --build
SELFBENCH_EXECUTION_BACKEND=modal docker compose up -d --build

# Vercel generation (after publishing the runtime image), with Vercel Harbor by default or any other environment
SELFBENCH_EXECUTION_BACKEND=vercel docker compose up -d --build
SELFBENCH_EXECUTION_BACKEND=vercel SELFBENCH_HARBOR_ENVIRONMENT=docker docker compose up -d --build
SELFBENCH_EXECUTION_BACKEND=vercel SELFBENCH_HARBOR_ENVIRONMENT=modal docker compose up -d --build
SELFBENCH_EXECUTION_BACKEND=vercel SELFBENCH_HARBOR_ENVIRONMENT=e2b docker compose up -d --build
DAYTONA_API_KEY=... SELFBENCH_EXECUTION_BACKEND=vercel SELFBENCH_HARBOR_ENVIRONMENT=daytona docker compose up -d --build

# E2B generation uses a prebuilt template; nothing is installed at sandbox runtime
export E2B_API_KEY=...
bun scripts/build-e2b-template.ts --name selfbench-runtime:v1
export SELFBENCH_E2B_TEMPLATE=selfbench-runtime:v1
SELFBENCH_EXECUTION_BACKEND=e2b docker compose up -d --build
# SELFBENCH_EXECUTION_BACKEND=e2b SELFBENCH_HARBOR_ENVIRONMENT=docker docker compose up -d --build
# SELFBENCH_EXECUTION_BACKEND=e2b SELFBENCH_HARBOR_ENVIRONMENT=modal docker compose up -d --build

# Explicit cross-provider combinations are also supported
SELFBENCH_EXECUTION_BACKEND=docker SELFBENCH_HARBOR_ENVIRONMENT=modal docker compose --profile sandbox up -d --build
SELFBENCH_EXECUTION_BACKEND=modal SELFBENCH_HARBOR_ENVIRONMENT=docker docker compose up -d --build
```

Provider selection belongs to the worker, so all runs on one task queue use the same pairing. See [Operations and deployment](docs/operations.md) for Vercel and [E2B setup](docs/operations.md#e2b) for template builds, credentials, plan limits, resources, cleanup, and unattended deployment.

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
- [HTTP API reference](docs/api.md)
- [Operations and deployment](docs/operations.md)

## License

[MIT](LICENSE) © 2026 Mupt AI.
