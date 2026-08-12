# SelfBench

SelfBench turns completed GitHub changes into private [Harbor](https://harborframework.com/) evaluations for coding agents. It finds real feature requests, builds tasks from the repository's base commit, hides the tests and reference solution, and checks that each task fails without a solution and passes with one.

SelfBench is distributed as the [`self-bench`](https://www.npmjs.com/package/self-bench) package and installed with **Bun**.

## Choose your setup

| Setup | Best for | Execution | State |
| --- | --- | --- | --- |
| Local | Trying SelfBench or small runs | Docker on your machine | Local Docker volumes |
| Temporal Cloud | Large repositories, long runs, and reliable unattended execution | Modal sandboxes | Temporal Cloud + object storage |

After a run is submitted, the workflow continues independently of the waiting CLI process. The local worker still depends on your machine and its Docker stack; Temporal Cloud is the recommended setup when a run may take hours or your laptop should not be responsible for the worker.

## Prerequisites

Installing the package requires [Bun](https://bun.sh/) 1.3.14 or newer. Running evaluations additionally requires:

- Docker with Compose
- `gh`, authenticated with access to the source repository
- Pi with an authenticated `openai-codex` account
- Codex CLI with an authenticated account

Modal execution additionally requires a Modal account and token. Temporal Cloud execution additionally requires a Temporal Cloud namespace and a durable artifact store such as Google Cloud Storage.

## Install

The package is named `self-bench`; it installs a command named `selfbench`. Install it globally with Bun:

```bash
bun install --global self-bench
selfbench --help
```

You can also try it without a global installation:

```bash
bunx --package self-bench selfbench --help
```

To develop SelfBench itself, clone the repository and use Bun:

```bash
git clone https://github.com/mupt-ai/self-bench.git
cd self-bench
bun install --frozen-lockfile
bun run build
bun link
selfbench --help
```

During development, run the TypeScript entrypoint without linking:

```bash
bun run cli -- --help
```

Authenticate the tools before starting a run:

```bash
gh auth login
# In Pi: /login -> OpenAI Codex
codex login
```

## Quick start: local Docker

This starts Postgres, Temporal, the SelfBench API, and a worker on your machine. The worker runs sandbox validation through Docker.

```bash
export SELFBENCH_API_TOKEN="$(openssl rand -hex 24)"
export GH_TOKEN="$(gh auth token)"

selfbench up --backend docker
export SELFBENCH_API_URL=http://127.0.0.1:8080

selfbench run \
  --repo /absolute/path/to/your/repository \
  --easy-count 30 \
  --medium-count 30 \
  --hard-count 10 \
  --output ./selfbench-evals.tar.gz
```

The `--repo` directory must be a Git checkout with a GitHub `origin`. SelfBench pins the current `HEAD`; uncommitted changes are ignored. It discovers candidate requests from sanitized local coding-session messages and merged, non-bot GitHub pull requests.

This quick start authors 70 candidates: 30 easy, 30 medium, and 10 hard. Counts are authoring budgets, not accepted-task guarantees. Candidates can be rejected during authoring, validation, audit, or review, and rejected candidates are not replaced.

A run may take hours. `--output` waits for the run to finish, then downloads and SHA-256-verifies the accepted tasks.

## Local commands

```bash
selfbench status RUN_ID
selfbench list
selfbench cancel RUN_ID
selfbench download RUN_ID ./selfbench-evals.tar.gz
```

If you are working from source rather than using `bun link`, use the same commands through Bun:

```bash
bun run cli -- status RUN_ID
```

Stop the local stack with Docker Compose:

```bash
docker compose down
```

Named Docker volumes retain Temporal history and generated artifacts. Back them up before removing them if you need to resume or inspect old runs.

## Reliable setup for larger repositories

For large repositories or unattended runs, use Temporal Cloud for workflow state and Modal for disposable execution sandboxes. Temporal Cloud does not host the SelfBench API or worker; deploy those separately.

```text
selfbench CLI
    -> SelfBench API
    -> Temporal Cloud namespace
    -> persistent SelfBench worker
    -> Modal sandboxes
    -> GCS artifact storage
```

The API and worker must use the same image version, Temporal namespace, task queue, artifact configuration, and `SELFBENCH_BUILD_COMMIT`. Keep the worker running on a long-lived container service; do not run it on a scale-to-zero request service. The API can run as a normal HTTP service.

### 1. Prepare Temporal Cloud and GCS

Create a Temporal Cloud namespace and obtain its address, namespace, API key, and TLS settings. Create a GCS bucket for SelfBench artifacts and give the worker/API service accounts access only to the SelfBench prefix.

Set these values in the API and worker environments:

```bash
SELFBENCH_TEMPORAL_ADDRESS=your-namespace.tmprl.cloud:7233
SELFBENCH_TEMPORAL_NAMESPACE=your-namespace
SELFBENCH_TEMPORAL_API_KEY=...
SELFBENCH_TEMPORAL_TLS=true
SELFBENCH_TASK_QUEUE=selfbench-production
SELFBENCH_ARTIFACT_BACKEND=gcs
SELFBENCH_GCS_BUCKET=your-selfbench-artifacts
SELFBENCH_GCS_PREFIX=selfbench
```

Do not use the local Compose defaults (`temporal` database credentials, loopback Temporal address, or local artifact volume) in a hosted deployment.

### 2. Deploy the API

Build and deploy `Dockerfile` as a service listening on port 8080. Configure:

```bash
SELFBENCH_API_HOST=0.0.0.0
SELFBENCH_API_TOKEN=use-a-secret-value
SELFBENCH_ARTIFACT_BACKEND=gcs
SELFBENCH_GCS_BUCKET=your-selfbench-artifacts
SELFBENCH_GCS_PREFIX=selfbench
SELFBENCH_TEMPORAL_ADDRESS=...
SELFBENCH_TEMPORAL_NAMESPACE=...
SELFBENCH_TEMPORAL_API_KEY=...
SELFBENCH_TEMPORAL_TLS=true
SELFBENCH_TASK_QUEUE=selfbench-production
```

Then point the CLI at the API:

```bash
export SELFBENCH_API_URL=https://selfbench-api.example.com
export SELFBENCH_API_TOKEN=use-a-secret-value
```

### 3. Deploy the worker

Run the same image with this command:

```bash
node dist/worker-main.js
```

Give the worker the Temporal, GCS, and task-queue settings above, plus the credentials it needs to discover, author, validate, and review tasks:

```bash
SELFBENCH_EXECUTION_BACKEND=modal
SELFBENCH_HARBOR_ENVIRONMENT=modal
MODAL_TOKEN_ID=...
MODAL_TOKEN_SECRET=...
GH_TOKEN=...
SELFBENCH_PI_AUTH_JSON=...
```

Provide the Codex auth JSON to the worker at `/home/node/.codex/auth.json` (the default location in the production image), for example through a read-only secret mount. Alternatively, mount it elsewhere and set `CODEX_AUTH_JSON_PATH` to that file. Keep model credentials in the worker only; the API does not need them.

### 4. Run against the hosted service

```bash
selfbench run \
  --repo /absolute/path/to/your/repository \
  --easy-count 2 \
  --medium-count 2 \
  --output ./selfbench-evals.tar.gz
```

The CLI uploads only repository metadata and sanitized provenance. The worker performs discovery, authoring, sandbox validation, review, audit, and export remotely.

### Large-repository guidance

- Prefer Modal over local Docker so the run is not tied to your laptop's CPU, memory, or Docker daemon.
- Start with one or two candidates per tier to confirm credentials, provenance, and repository compatibility before increasing the budget.
- Treat counts as authoring attempts, not accepted-task guarantees.
- Keep the worker alive for the entire run; discovery and authoring are retryable, but a missing worker stops progress.
- Keep GCS and Temporal state persistent. Do not delete the artifact prefix or Temporal namespace while runs are active.
- Use a dedicated task queue for each deployment and ensure the API and worker use exactly the same value.
- Use `status`, `list`, and `download` from any machine that can reach the API.

## Backend options

The local `up` command configures one execution backend for the stack:

```bash
# Local Docker sandboxes; simplest, usually one activity at a time
selfbench up --backend docker

# Modal sandboxes; better for concurrency and larger runs
modal token new
selfbench up --backend modal
```

For Modal, `selfbench up` uses `~/.modal.toml` by default. Override it with:

```bash
selfbench up --backend modal --modal-config /absolute/path/to/.modal.toml
```

## Development

```bash
bun install --frozen-lockfile
bun run check
bun run test
bun run build
bun run validate
```

Useful development commands:

```bash
bun run cli -- --help
bun run dev:api
bun run dev:worker
bun run dev:review
```

More detail is available in:

- [Task construction](docs/task-construction.md)
- [Evaluation workflows](docs/evaluations.md)
- [Operations and deployment](docs/operations.md)

## License

[MIT](LICENSE) © 2026 Mupt AI.
