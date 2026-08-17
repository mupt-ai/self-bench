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

Sandbox-provider credentials are separate. Modal accepts its mounted profile or token pair. For a local Vercel worker, `self-bench setup vercel` stores a project-scoped token in an owner-only local profile. Unattended workers use the equivalent `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID` environment variables. Keep provider credentials on the worker; the API does not need them.

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

Use `--modal-config` whenever either side uses Modal. A worker has one fixed pairing; do not run workers with different provider settings on the same Temporal task queue. Run and export metadata record both choices, plus the effective Vercel timeout cap when applicable.

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

Vercel is a generation backend only; choose Docker or Modal for Harbor. SelfBench supports both Vercel's 45-minute Hobby Sandbox ceiling and the longer paid-team ceiling. Discovery requests 45 minutes, review requests 15 minutes, and authoring and repair request two hours; setup detects the selected project's effective capability and caps every Vercel stage centrally when necessary. Sandbox use, VCR storage, memory, active CPU, and data transfer are metered by Vercel; configure Spend Management before unattended runs. Vercel Hobby use is intended for personal, non-commercial work.

#### Interactive local setup

Install the current Vercel CLI and make sure Docker is available for the runtime-image build:

```bash
npm install --global vercel@latest
self-bench setup vercel
```

Interactive setup keeps long-running publication and capability checks compact, with a live elapsed timer that freezes when each step completes. Use `self-bench setup vercel --verbose` to stream the underlying Vercel CLI and Docker build output; compact mode reveals retained command output automatically when a step fails.

Setup uses Vercel CLI browser login for control-plane selection and VCR publication. It then:

1. shows a searchable team or personal-scope picker;
2. offers a searchable existing-project picker or creation of a dedicated project;
3. asks for a project name, defaulting to `selfbench-sandbox`, and retries rather than silently suffixing an unavailable name;
4. publishes the pinned `Dockerfile.sandbox` runtime to the project's `selfbench-runtime` VCR repository;
5. prints the Vercel token page and asks for a manually created access token restricted to the selected project, with terminal echo disabled;
6. creates and immediately deletes a one-vCPU, nonpersistent probe sandbox to verify the token, image, command execution, cleanup, and effective duration ceiling;
7. activates the profile only after every required check succeeds.

The project does not need a deployment. Its metered use is billed to its owning Vercel scope. CLI login and worker configuration are deliberately separate: CLI login selects and provisions resources, while the project-scoped token plus team and project IDs configure the SelfBench worker. Although the Vercel SDK supports ambient OIDC on Vercel infrastructure, SelfBench does not use it.

Profiles live in `~/.selfbench/config.json`; tokens live separately in `~/.selfbench/credentials.json`. The directory is mode `0700`, both files are mode `0600`, writes are atomic, and displayed setup output never includes the token. Override the directory with `SELFBENCH_CONFIG_DIR` when isolation is needed. To maintain more than one project profile:

```bash
self-bench setup vercel --profile secondary
self-bench up --backend vercel --vercel-profile secondary --harbor-environment modal
```

Without `--vercel-profile`, `self-bench up` uses the active profile most recently saved by setup. Rerunning setup revalidates the existing project and token by default. It fingerprints the exact Dockerfile—including its digest-pinned base and pinned tool defaults—plus the fingerprint schema and target platform; if the matching immutable VCR image is already ready, publication is skipped. A changed runtime produces a new content-derived tag and digest. The final image reference is always digest-pinned, and existing digests are not deleted automatically. If the default VCR repository contains unrelated images, setup leaves it untouched and asks for another name.

When rerunning setup for a named profile, the available actions are:

- **Revalidate** keeps the saved team, project, and token. It verifies current access, reuses a compatible ready image, republishes only if the runtime fingerprint changed, reruns the temporary Sandbox capability probe, and refreshes the saved image digest and timeout cap.
- **Replace the access token** keeps the saved team and project, requests a new project-scoped token, and activates it only after verification succeeds. It replaces only the locally stored credential; revoke the old token separately in Vercel if necessary.
- **Choose another team or project** repoints the same local profile name after the new project, image, and token pass verification. It does not delete the previous Vercel project or images. Use a different `--profile` name instead when both configurations should remain available.

If setup is interrupted after creating a project or VCR repository, it reports the failure and leaves the durable resource in place; rerun setup to continue. It never activates a partial profile. Vercel projects and VCR images are reusable across SelfBench runs and persist after `self-bench down`.

#### Start the local worker

```bash
self-bench up --backend vercel --harbor-environment modal
# self-bench up --backend vercel --harbor-environment docker
```

Modal Harbor also needs the Modal profile or token pair. Vercel control credentials are removed from the Harbor child process for both Harbor environments. `self-bench up` resolves the profile, then validates the complete credential triple, digest-pinned image, and timeout cap before starting Compose.

The setup probe records a two-hour effective SelfBench ceiling when the requested two-hour sandbox is accepted. If Vercel returns its exact 45-minute limit response, setup verifies a 45-minute sandbox, explains the impact, and asks before saving that cap. Longer authoring and repair requests then run for at most 45 minutes and return exit 124 on timeout, so only the affected candidate is rejected. Discovery and review retain their shorter requested limits. The effective cap is included in run and export metadata.

#### Environment-only and unattended workers

`self-bench setup vercel` is intentionally interactive. CI and long-running workers can provide the same resolved values through environment variables or a secret manager:

```bash
export VERCEL_TOKEN=...
export VERCEL_TEAM_ID=team_...
export VERCEL_PROJECT_ID=prj_...
export SELFBENCH_VERCEL_IMAGE='selfbench-runtime@sha256:...'
export SELFBENCH_VERCEL_TIMEOUT_CAP=2h  # use 45m when that is the verified ceiling

self-bench up --backend vercel --harbor-environment modal
```

The image must already have been published from `Dockerfile.sandbox` to the same project's VCR as `linux/amd64`. Use the bare repository-plus-digest form shown above; tags and rolling aliases are rejected. VCR repositories are project-scoped by default, so a sandbox in another project cannot use the image unless the repository is explicitly shared. Explicit token and image values take precedence over profile values, and a lower timeout cap may be supplied; an override cannot exceed the profile's verified ceiling. Supplying a complete credential/image environment requires no local profile; partial team or project overrides are rejected rather than combined across scopes.

Vercel defaults to four concurrent worker activities. A standard SelfBench sandbox requests 4 vCPUs, which Vercel pairs with 8 GB of memory, plus 32 GB of ephemeral disk. Unsupported CPU/memory combinations are rejected before allocation. Raise `SELFBENCH_ACTIVITY_CONCURRENCY` only after considering the team's allocation limits and budget. Lower it—often to `1`—when using Docker Harbor on a smaller local machine, because the Vercel-oriented default does not account for local Harbor capacity.

Each sandbox run uses a fresh nonpersistent sandbox (`persistent: false`). SelfBench does not create snapshots or resume stopped sandboxes, and it attempts to delete every sandbox when the run ends. If deletion cannot be confirmed, the activity fails so the cleanup problem remains visible. If the worker crashes before cleanup, compute may continue until the provider timeout; Vercel then discards the filesystem, although the stopped sandbox record may remain for up to 14 days unless manually deleted.

Cancel active workflows and let cleanup finish before stopping the stack.

Common failures:

- A newly changed paid plan may take time to propagate its longer timeout entitlement. Rerun `self-bench setup vercel` to repeat the short-lived capability probe and update the saved cap; if a correctly scoped paid project continues to detect 45 minutes, verify team/project ownership before contacting Vercel Support.
- `not_found` on create usually means the image belongs to another project or is private and unshared. Prefer the same project and a bare digest reference.
- `image_not_ready` means VCR has not finished optimizing the `linux/amd64` image.
- Repeated HTTP 429 allocation failures indicate project/team allocation pressure. The executor honors bounded `Retry-After` retries; reduce activity concurrency if pressure continues.
- Cleanup errors fail the activity rather than silently leaving reusable state and include the exact `selfbench-...` sandbox name for diagnosis.

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
| `SELFBENCH_VERCEL_IMAGE` | profile or — | Required digest-pinned VCR image for Vercel execution |
| `SELFBENCH_VERCEL_TIMEOUT_CAP` | `2h` | Vercel worker and API; accepts integer milliseconds or `ms`, `s`, `m`, `h` units |
| `SELFBENCH_CONFIG_DIR` | `~/.selfbench` | Local CLI profile directory; not needed with a complete Vercel environment |
| `VERCEL_TOKEN` | profile or unset | Vercel worker; explicit project-scoped access token |
| `VERCEL_TEAM_ID` | profile or unset | Vercel worker |
| `VERCEL_PROJECT_ID` | profile or unset | Vercel worker; must be able to resolve the configured image |
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
SELFBENCH_VERCEL_IMAGE=selfbench-runtime@sha256:...
SELFBENCH_VERCEL_TIMEOUT_CAP=2h     # or the verified 45m ceiling
VERCEL_TOKEN=...
VERCEL_TEAM_ID=team_...
VERCEL_PROJECT_ID=prj_...
```

Keep the Vercel credential triple on the worker only. A project-scoped token is sufficient when the runtime image belongs to that project. The API must also receive `SELFBENCH_EXECUTION_BACKEND`, `SELFBENCH_HARBOR_ENVIRONMENT`, `SELFBENCH_VERCEL_IMAGE`, and `SELFBENCH_VERCEL_TIMEOUT_CAP` because it stamps the generation backend, Harbor environment, image, and effective timeout cap into each run manifest; it never needs the credential triple.

This repository defines the application boundary, not turnkey cloud infrastructure. Project, region, ingress, IAM, GCS, and Temporal provisioning remain deployment-specific.

## Security boundary

- Exports contain source snapshots, held-out tests, and reference solutions. They are sensitive and unencrypted.
- Artifact references carry byte length and SHA-256; reads verify integrity.
- Local artifact paths and GCS object names are confined to their configured roots. GCS IAM should enforce the same prefix independently.
- Sandboxes receive only the selected model credential: `OPENAI_API_KEY` by default, or a stage-specific subscription credential for compatibility deployments.
- Sandboxes contain both a source checkout and a short-lived model credential. Use SelfBench only with repositories you trust to execute; it is not a malware-analysis service.
- Docker uses disposable containers and volumes and removes them after normal completion. A host crash can leave resources for an operator to inspect and remove. Modal uses disposable Sandboxes. Vercel uses nonpersistent named sandboxes, attempts permanent deletion after each run, and fails the activity when deletion cannot be confirmed; inspect the project after worker crashes or cleanup failures.
- Vercel control credentials authenticate only the worker's Sandbox control plane and are stripped before Harbor starts. They are never workload command secrets.
