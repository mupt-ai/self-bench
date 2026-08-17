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

self-bench requires GitHub and model credentials:

- `gh auth login` supplies read access to merged pull requests. Export `GH_TOKEN="$(gh auth token)"` for the worker. Write access is not required.
- `OPENAI_API_KEY` powers discovery, authoring, review, constrained repair, and model evaluation. This is the recommended model-authentication path.

Existing deployments may continue using ChatGPT subscription authentication by providing both `SELFBENCH_PI_AUTH_JSON` and `SELFBENCH_CODEX_AUTH_JSON`. API-key authentication takes precedence when `OPENAI_API_KEY` is set.

Sandbox-provider credentials are separate. Modal accepts its mounted profile or token pair. Vercel execution requires the explicit `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID` triple described below. Keep all of these on the worker; the API does not need provider or model credentials.

## Execution backends and Harbor

SelfBench uses one provider for discovery, authoring, semantic review, and repair sandboxes. It separately invokes Harbor for nop/oracle validation. Docker and Modal default Harbor to the matching environment. Vercel has no Harbor environment, so `--harbor-environment docker|modal` is mandatory.

```bash
self-bench up --backend docker                         # Docker + Docker
self-bench up --backend modal                          # Modal + Modal
self-bench up --backend vercel --harbor-environment docker
self-bench up --backend vercel --harbor-environment modal
self-bench up --backend docker --harbor-environment modal
self-bench up --backend modal --harbor-environment docker
```

Use `--modal-config` whenever either side uses Modal. A worker has one fixed pairing; do not run workers with different provider settings on the same Temporal task queue. Run and export metadata record both choices.

### Docker

Build the worker's sandbox image once:

```bash
self-bench up --backend docker
```

Docker defaults to one activity at a time because sandboxes share the host. Each candidate defaults to 4 CPUs, 8,192 MB RAM, and 20,480 MB storage. Authored tasks may request other positive limits.

### Modal

Authenticate Modal and mount its profile into the worker:

```bash
modal token new

self-bench up --backend modal

# If your profile is not at ~/.modal.toml:
self-bench up --backend modal --modal-config /absolute/path/to/.modal.toml
```

When Modal is used for generation or Harbor, SelfBench mounts `~/.modal.toml` by default; `--modal-config` overrides that path. A secret manager may provide `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` instead. Empty token environment variables are removed at worker startup so they cannot override a valid mounted profile.

Modal defaults to 20 concurrent worker activities. Discovery starts eight independently retryable shards, and candidate slots are continuously refilled. Discovery and authoring stop after eight minutes without process output; review stops after five. Discovery also has a 45-minute per-attempt deadline and up to three attempts per shard.

### Vercel Sandbox

Vercel is a generation backend only; choose Docker or Modal for Harbor. The workflow includes authoring and repair stages with two-hour sandbox deadlines, so the owning Vercel scope must have an effective limit of at least two hours. Vercel currently documents a 45-minute Hobby maximum and a 24-hour Pro/Enterprise maximum. Sandbox use, VCR storage, memory, active CPU, and data transfer are metered by Vercel; configure Spend Management before unattended runs.

#### 1. Create a project and access token

Create or select a project in the team that should own both the sandboxes and their runtime image. The project does not need a deployment. Create a short-lived, project-scoped [Vercel access token](https://vercel.com/docs/accounts/access-tokens) for that project and record the team and project IDs from Vercel settings.

The Vercel SDK can use ambient OIDC when code runs on Vercel infrastructure. SelfBench worker configuration instead requires explicit `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID` values. Vercel CLI login authenticates only the image-publication workflow; its session is not passed to the worker.

#### 2. Publish the runtime image

SelfBench requires its pinned Node, Pi, Codex, GitHub CLI, and `/work` runtime, so rolling Vercel managed images are not used. Publish `Dockerfile.sandbox` to the same project's [Vercel Container Registry](https://vercel.com/docs/container-registry/getting-started) as `linux/amd64`. Install the current [Vercel CLI](https://vercel.com/docs/cli) on the operator machine first:

```bash
npm install --global vercel
vercel login

export VERCEL_PROJECT_ID=prj_...
IMAGE_TAG="$(git rev-parse --short HEAD)"

vercel vcr login --project "$VERCEL_PROJECT_ID" docker
vercel vcr build \
  --project "$VERCEL_PROJECT_ID" \
  --platform linux/amd64 \
  --push \
  docker . "selfbench-sandbox:$IMAGE_TAG" \
  -- --file Dockerfile.sandbox

vercel vcr tag inspect \
  --project "$VERCEL_PROJECT_ID" \
  --format json \
  selfbench-sandbox "$IMAGE_TAG"
```

Wait for VCR to report the image as `Ready`, then copy its immutable `sha256:...` digest. Configure the project-relative form so team and project slugs are not embedded in exported run metadata:

```bash
export SELFBENCH_VERCEL_IMAGE='selfbench-sandbox@sha256:...'
```

Tags and rolling aliases are rejected. VCR repositories are project-scoped by default; a sandbox in another project cannot use the image unless the repository is explicitly shared. Keeping the token, project ID, and image in the same project is the simplest configuration.

#### 3. Start the worker

```bash
export VERCEL_TOKEN=...
export VERCEL_TEAM_ID=team_...
export VERCEL_PROJECT_ID=prj_...
export SELFBENCH_VERCEL_IMAGE='selfbench-sandbox@sha256:...'

# Choose exactly one Harbor environment.
self-bench up --backend vercel --harbor-environment modal
# self-bench up --backend vercel --harbor-environment docker
```

Modal Harbor also needs the Modal profile or token pair. Vercel control credentials are removed from the Harbor child process for both Harbor environments. `self-bench up` validates the complete credential triple and digest-pinned image before starting Compose.

Vercel defaults to four concurrent worker activities. A standard SelfBench sandbox requests 4 vCPUs, which Vercel pairs with 8 GB of memory, plus 32 GB of ephemeral disk. Unsupported CPU/memory combinations are rejected before allocation. Raise `SELFBENCH_ACTIVITY_CONCURRENCY` only after considering the team's allocation limits and budget. Lower it—often to `1`—when using Docker Harbor on a smaller local machine, because the Vercel-oriented default does not account for local Harbor capacity.

Each sandbox run uses a fresh nonpersistent sandbox (`persistent: false`). SelfBench does not create snapshots or resume stopped sandboxes, and it attempts to delete every sandbox when the run ends. If deletion cannot be confirmed, the activity fails so the cleanup problem remains visible. If the worker crashes before cleanup, compute may continue until the provider timeout; Vercel then discards the filesystem, although the stopped sandbox record may remain for up to 14 days unless manually deleted.

For manual inventory, install and authenticate Vercel's separate [Sandbox CLI](https://vercel.com/docs/sandbox/cli-reference), then include stopped records in the listing:

```bash
npm install --global sandbox
sandbox login
sandbox list --all
sandbox snapshots list
sandbox remove UNEXPECTED_SANDBOX_NAME
```

Cancel active workflows and let cleanup finish before stopping the stack. The project dashboard provides the same inspection and removal boundary.

Common failures:

- `timeout should be <= 45m` means Vercel is applying the Hobby duration ceiling. Verify the token, team/project ownership, and effective paid plan; after a new paid plan starts, entitlement propagation may lag. Retry a cheap, short-lived create at the intended timeout later before contacting Vercel Support if a correctly scoped Pro/Enterprise project still receives it.
- `not_found` on create usually means the image belongs to another project or is private and unshared. Prefer the same project and a bare digest reference.
- `image_not_ready` means VCR has not finished optimizing the `linux/amd64` image.
- Repeated HTTP 429 allocation failures indicate project/team allocation pressure. The executor honors bounded `Retry-After` retries; reduce activity concurrency if pressure continues.
- Cleanup errors fail the activity rather than silently leaving reusable state. Inspect and remove the exact `selfbench-...` sandbox before retrying.

## CLI behavior

`self-bench run` requires an absolute or relative path to a Git checkout whose `origin` is an HTTPS or SSH GitHub URL. It pins `HEAD`; uncommitted content is excluded.

The CLI collects two types of provenance:

1. sanitized user messages from Pi, Claude Code, and Codex sessions associated with the checkout or its worktrees;
2. exact titles and bodies from up to 500 recent merged pull requests by non-bot authors that clear coarse tier-appropriate size thresholds.

GitHub records remain labeled `github-pull-request` and are bound to their own repository, PR number, and canonical URL. Local requests are preferred when they clearly describe the same change. Common credential forms and injected harness context are removed, but this is not a general secret scanner.

```bash
self-bench run \
  --repo /absolute/path/to/repository \
  --easy-count 5 \
  --medium-count 10 \
  --hard-count 5 \
  --model gpt-5.6-sol \
  --output ./self-bench-tasks.tar.gz
```

The three tier counts total 1–100. Each is a fixed candidate authoring budget, not an accepted-task target: rejected candidates are not replaced. Discovery expands only until it fills each requested tier budget, then accepted tasks are exported.

`--output` implies `--wait`. It reports phase changes, requires a successful Temporal terminal state, downloads with create-only filesystem semantics, and verifies the API-provided SHA-256.

A custom `--run-id` must contain 3–63 lowercase letters, digits, or hyphens and start with a letter or digit.

## HTTP API

The CLI is the recommended client. The API exposes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness check |
| `POST` | `/v1/provenance?runId=...` | Store sanitized provenance JSONL |
| `POST` | `/v1/runs` | Start a tiered candidate workflow |
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
| `SELFBENCH_EXECUTION_BACKEND` | `docker` | Worker; `docker`, `modal`, or `vercel` |
| `SELFBENCH_DOCKER_IMAGE` | `selfbench-sandbox:local` | Docker worker |
| `SELFBENCH_HARBOR_ENVIRONMENT` | matching Docker/Modal backend | Worker; required as `docker` or `modal` for Vercel |
| `SELFBENCH_ACTIVITY_CONCURRENCY` | `1` Docker, `20` Modal, `4` Vercel | Worker |
| `SELFBENCH_MODAL_APP` | `selfbench` | Modal worker |
| `SELFBENCH_MODAL_ENVIRONMENT` | — | Modal worker |
| `SELFBENCH_MODAL_IMAGE` | `node:22-bookworm` | Modal worker |
| `SELFBENCH_MODAL_CONFIG_PATH` | `/dev/null` | Compose host mount; set by `self-bench up --modal-config` locally |
| `SELFBENCH_VERCEL_IMAGE` | — | Required digest-pinned VCR image for Vercel execution |
| `VERCEL_TOKEN` | — | Vercel worker; explicit access token |
| `VERCEL_TEAM_ID` | — | Vercel worker |
| `VERCEL_PROJECT_ID` | — | Vercel worker; must be able to resolve the configured image |
| `SELFBENCH_TEMPORAL_ADDRESS` | `127.0.0.1:7233` | API and worker |
| `SELFBENCH_TEMPORAL_NAMESPACE` | `default` | API and worker |
| `SELFBENCH_TASK_QUEUE` | `selfbench-dev` | API and worker |
| `OPENAI_API_KEY` | — | Worker sandboxes and matrix harness |
| `SELFBENCH_PI_AUTH_JSON` | — | Optional Pi subscription-auth fallback |
| `SELFBENCH_CODEX_AUTH_JSON` | — | Optional Codex subscription-auth fallback |
| `GH_TOKEN` | — | Worker GitHub reads |
| `CODEX_AUTH_JSON_PATH` | `~/.codex/auth.json` | Optional matrix subscription-auth file |

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

Run `node dist/temporal/worker-main.js` from the same image digest on a long-running container platform, not a scale-to-zero request service. Give it the same Temporal, task queue, and GCS configuration plus:

```text
SELFBENCH_EXECUTION_BACKEND=modal
SELFBENCH_HARBOR_ENVIRONMENT=modal
MODAL_TOKEN_ID=...
MODAL_TOKEN_SECRET=...
GH_TOKEN=...
OPENAI_API_KEY=...
```

The worker owns model, GitHub, Modal, and Harbor credentials. Use separate least-privilege service accounts and a secret manager. Grant GCS object access only to the configured prefix, use a TLS-enabled Temporal namespace, and keep API/worker image digests and `SELFBENCH_TASK_QUEUE` identical.

For Vercel generation, replace the execution settings above with:

```text
SELFBENCH_EXECUTION_BACKEND=vercel
SELFBENCH_HARBOR_ENVIRONMENT=modal  # or docker
SELFBENCH_VERCEL_IMAGE=selfbench-sandbox@sha256:...
VERCEL_TOKEN=...
VERCEL_TEAM_ID=team_...
VERCEL_PROJECT_ID=prj_...
```

Keep the Vercel credential triple on the worker only. A project-scoped token is sufficient when the runtime image belongs to that project. The API must also receive `SELFBENCH_EXECUTION_BACKEND`, `SELFBENCH_HARBOR_ENVIRONMENT`, and the non-secret `SELFBENCH_VERCEL_IMAGE` because it stamps the generation backend, Harbor environment, and image into each run manifest; it never needs the credential triple.

This repository defines the application boundary, not turnkey cloud infrastructure. Project, region, ingress, IAM, GCS, and Temporal provisioning remain deployment-specific.

## Security boundary

- Exports contain source snapshots, held-out tests, and reference solutions. They are sensitive and unencrypted.
- Artifact references carry byte length and SHA-256; reads verify integrity.
- Local artifact paths and GCS object names are confined to their configured roots. GCS IAM should enforce the same prefix independently.
- Sandboxes receive only the selected model credential: `OPENAI_API_KEY` by default, or a stage-specific subscription credential for compatibility deployments.
- Sandboxes contain both a source checkout and a short-lived model credential. Use SelfBench only with repositories you trust to execute; it is not a malware-analysis service.
- Docker uses disposable containers and volumes and removes them after normal completion. A host crash can leave resources for an operator to inspect and remove. Modal uses disposable Sandboxes. Vercel uses nonpersistent named sandboxes, attempts permanent deletion after each run, and fails the activity when deletion cannot be confirmed; inspect the project after worker crashes or cleanup failures.
- Vercel control credentials authenticate only the worker's Sandbox control plane and are stripped before Harbor starts. They are never workload command secrets.
