# Operations and deployment

This document covers SelfBench configuration, persistence, authentication, the HTTP API, and cloud deployment. Start with the repository [README](../README.md) for the shortest local workflow.

## Local stack

`docker compose up` starts:

- Postgres for Temporal state;
- Temporal;
- the SelfBench API;
- the SelfBench worker;
- a persistent artifact volume.

The worker mounts the host Docker socket for local sandboxes. The API never receives the Docker socket or model credentials. The local Postgres user and password are development defaults, both named `temporal`.

Temporal and artifact state live in the `selfbench_temporal-postgres` and `selfbench_artifacts` volumes. Back up those volumes before an upgrade when workflow history or generated artifacts must be retained. SelfBench has no application database migrations.

## Credentials

SelfBench uses three separate credentials:

- `gh auth login` supplies read access to merged pull requests. Export `GH_TOKEN="$(gh auth token)"` for the worker. Write access is not required.
- Pi's `openai-codex` entry in `~/.pi/agent/auth.json` powers discovery, authoring, and review.
- `~/.codex/auth.json` powers the constrained repair step and agent evaluation.

Both model credentials must be backed by a ChatGPT subscription. SelfBench removes API-key fields and does not fall back to `OPENAI_API_KEY`.

Compose mounts the default auth files read-only. Override their host paths before starting the stack when necessary:

```bash
export SELFBENCH_PI_AUTH_PATH=/absolute/path/to/pi-auth.json
export SELFBENCH_CODEX_AUTH_PATH=/absolute/path/to/codex-auth.json
node dist/cli.js up
```

## Execution backends

### Docker

Build the worker's sandbox image once:

```bash
node dist/cli.js up --backend docker
```

Docker defaults to one activity at a time because sandboxes share the host. Each candidate defaults to 4 CPUs, 8,192 MB RAM, and 20,480 MB storage. Authored tasks may request other positive limits.

### Modal

Authenticate Modal and mount its profile into the worker:

```bash
modal token new

node dist/cli.js up --backend modal

# If your profile is not at ~/.modal.toml:
node dist/cli.js up --backend modal --modal-config /absolute/path/to/.modal.toml
```

`selfbench up` selects both sandbox execution and Harbor validation for the requested backend. Modal mounts `~/.modal.toml` by default; `--modal-config` overrides that path. A secret manager may provide `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` instead. Empty token environment variables are removed at worker startup so they cannot override a valid mounted profile.

Modal defaults to 20 concurrent worker activities. Discovery starts eight independently retryable shards, and candidate slots are continuously refilled. Discovery and authoring stop after eight minutes without process output; review stops after five. Discovery also has a 45-minute per-attempt deadline and up to three attempts per shard.

## CLI behavior

`selfbench run` requires an absolute or relative path to a Git checkout whose `origin` is an HTTPS or SSH GitHub URL. It pins `HEAD`; uncommitted content is excluded.

The CLI collects two types of provenance:

1. sanitized user messages from Pi, Claude Code, and Codex sessions associated with the checkout or its worktrees;
2. exact titles and bodies from up to 500 recent merged pull requests by non-bot authors that clear coarse hard-mode size thresholds.

GitHub records remain labeled `github-pull-request` and are bound to their own repository, PR number, and canonical URL. Local requests are preferred when they clearly describe the same change. Common credential forms and injected harness context are removed, but this is not a general secret scanner.

```bash
node dist/cli.js run \
  --repo /absolute/path/to/repository \
  --count 10 \
  --reserve-count 10 \
  --model gpt-5.6-sol \
  --output ./selfbench-tasks.tar.gz
```

`--count` accepts 1–100. `--reserve-count` accepts 0–100 and defaults to `--count`. When the initial pool is exhausted, discovery requests non-duplicate candidates until the target is accepted or 100 candidates have been considered.

`--output` implies `--wait`. It reports phase changes, requires a successful Temporal terminal state, downloads with create-only filesystem semantics, and verifies the API-provided SHA-256.

A custom `--run-id` must contain 3–63 lowercase letters, digits, or hyphens and start with a letter or digit.

## HTTP API

The CLI is the recommended client. The API exposes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness check |
| `POST` | `/v1/provenance?runId=...` | Store sanitized provenance JSONL |
| `POST` | `/v1/runs` | Start a hard-mode workflow |
| `GET` | `/v1/runs` | List workflows |
| `GET` | `/v1/runs/:runId` | Read progress and rejection reasons |
| `POST` | `/v1/runs/:runId/cancel` | Request Temporal cancellation |
| `GET` | `/v1/runs/:runId/export` | Download a completed export |

`/healthz` is unauthenticated. Every other route requires `Authorization: Bearer $SELFBENCH_API_TOKEN` when the token is configured. Startup fails if the API binds beyond loopback without a token.

Run status includes its phase, accepted/rejected counts, per-candidate stage, discovery wave, completed/failed shard counts, and current candidates. Failed generation runs use a new run ID; the separate agent matrix is resumable through completed Harbor job reuse.

SelfBench has no remote deletion route. Delete local artifact-volume data or GCS run prefixes through normal operator tooling.

## Configuration

| Variable | Default | Used by |
| --- | --- | --- |
| `SELFBENCH_API_HOST` | `127.0.0.1` | API |
| `SELFBENCH_API_PORT` | `8080` | API |
| `SELFBENCH_API_TOKEN` | unset | API and CLI |
| `SELFBENCH_ARTIFACT_BACKEND` | `local` | API and worker |
| `SELFBENCH_ARTIFACT_DIR` | `.selfbench/artifacts` | Local artifact store |
| `SELFBENCH_GCS_BUCKET` | — | GCS artifact store |
| `SELFBENCH_GCS_PREFIX` | `selfbench` | GCS artifact store |
| `SELFBENCH_EXECUTION_BACKEND` | `docker` | Worker; set by `selfbench up --backend` locally |
| `SELFBENCH_HARBOR_ENVIRONMENT` | execution backend | Worker; set by `selfbench up --backend` locally |
| `SELFBENCH_ACTIVITY_CONCURRENCY` | `1` Docker, `20` Modal | Worker |
| `SELFBENCH_MODAL_APP` | `selfbench` | Modal worker |
| `SELFBENCH_MODAL_ENVIRONMENT` | — | Modal worker |
| `SELFBENCH_MODAL_IMAGE` | `node:22-bookworm` | Modal worker |
| `SELFBENCH_MODAL_CONFIG_PATH` | `/dev/null` | Compose host mount; set by `selfbench up --modal-config` locally |
| `SELFBENCH_TEMPORAL_ADDRESS` | `127.0.0.1:7233` | API and worker |
| `SELFBENCH_TEMPORAL_NAMESPACE` | `default` | API and worker |
| `SELFBENCH_TASK_QUEUE` | `selfbench-dev` | API and worker |
| `SELFBENCH_PI_AUTH_PATH` | `~/.pi/agent/auth.json` | Compose host mount |
| `SELFBENCH_PI_AUTH_JSON` | — | Worker secret alternative |
| `SELFBENCH_CODEX_AUTH_PATH` | `~/.codex/auth.json` | Compose host mount |
| `GH_TOKEN` | — | Worker GitHub reads |
| `CODEX_AUTH_JSON_PATH` | `~/.codex/auth.json` | Worker and matrix harness |

## Cloud topology

The API is a regular request-oriented HTTP service suitable for Cloud Run. Deploy `Dockerfile` with its default `node dist/api-main.js` command and port 8080:

```text
SELFBENCH_API_HOST=0.0.0.0
SELFBENCH_API_TOKEN=...
SELFBENCH_ARTIFACT_BACKEND=gcs
SELFBENCH_GCS_BUCKET=...
SELFBENCH_GCS_PREFIX=selfbench
SELFBENCH_TEMPORAL_ADDRESS=...
SELFBENCH_TEMPORAL_NAMESPACE=...
SELFBENCH_TEMPORAL_API_KEY=...
SELFBENCH_TEMPORAL_TLS=true
```

Run `node dist/worker-main.js` from the same image digest on a long-running container platform, not a scale-to-zero request service. Give it the same Temporal, task queue, and GCS configuration plus:

```text
SELFBENCH_EXECUTION_BACKEND=modal
SELFBENCH_HARBOR_ENVIRONMENT=modal
MODAL_TOKEN_ID=...
MODAL_TOKEN_SECRET=...
GH_TOKEN=...
SELFBENCH_PI_AUTH_JSON=...
```

The worker owns model, GitHub, Modal, and Harbor credentials. Use separate least-privilege service accounts and a secret manager. Grant GCS object access only to the configured prefix, use a TLS-enabled Temporal namespace, and keep API/worker image digests and `SELFBENCH_TASK_QUEUE` identical.

This repository defines the application boundary, not turnkey cloud infrastructure. Project, region, ingress, IAM, GCS, and Temporal provisioning remain deployment-specific.

## Security boundary

- Exports contain source snapshots, held-out tests, and reference solutions. They are sensitive and unencrypted.
- Artifact references carry byte length and SHA-256; reads verify integrity.
- Local artifact paths and GCS object names are confined to their configured roots. GCS IAM should enforce the same prefix independently.
- Author and review sandboxes receive only Pi's validated `openai-codex` OAuth entry. Repair receives a validated ChatGPT Codex token set with API-key fields removed.
- Sandboxes contain both a source checkout and a short-lived model credential. Use SelfBench only with repositories you trust to execute; it is not a malware-analysis service.
- Docker uses disposable containers and volumes and removes them after normal completion. A host crash can leave resources for an operator to inspect and remove. Modal uses disposable Sandboxes.
