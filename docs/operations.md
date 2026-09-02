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
- `OPENAI_API_KEY` powers discovery, authoring rounds, and verification rounds. This is the recommended model-authentication path.

For ChatGPT subscription authentication, provide `SELFBENCH_PI_AUTH_JSON` containing Pi's `openai-codex` OAuth credential. API-key authentication takes precedence when `OPENAI_API_KEY` is set. SelfBench does not install or invoke the Codex CLI; exported-task evaluation credentials belong to Harbor.

Sandbox-provider credentials are separate. Modal accepts its mounted profile or token pair. For a local Vercel worker, `self-bench setup vercel` stores a project-scoped token in an owner-only local profile. Unattended Vercel workers use the equivalent `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID` environment variables. E2B workers use `E2B_API_KEY` and optionally `E2B_DOMAIN`; E2B setup reads the same values but does not save them. Keep provider credentials on the worker. The API receives provider/template metadata for run manifests but never needs Vercel or E2B control credentials.

## Execution backends and Harbor

SelfBench uses one provider for discovery, authoring-round, and verification-round sandboxes. It separately invokes Harbor for the build, smoke, nop, and oracle gates of every round. Docker and Modal default Harbor to the matching environment. Vercel and E2B have no Harbor environment, so `--harbor-environment docker|modal` is mandatory for either hosted generation backend.

```bash
self-bench up --backend docker                         # Docker + Docker
self-bench up --backend modal                          # Modal + Modal
self-bench up --backend vercel --harbor-environment docker
self-bench up --backend vercel --harbor-environment modal
self-bench up --backend e2b --harbor-environment docker
self-bench up --backend e2b --harbor-environment modal
self-bench up --backend docker --harbor-environment modal
self-bench up --backend modal --harbor-environment docker
```

Use `--modal-config` whenever either side uses Modal. A worker has one fixed pairing; do not run workers with different provider settings on the same Temporal task queue. Run and export metadata record both choices, plus the configured hosted-provider timeout cap when applicable.

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

Modal defaults to 20 concurrent worker activities. Discovery starts eight independently retryable shards, and candidate slots are continuously refilled. Discovery, authoring rounds, and verification rounds stop after eight minutes without process output. Discovery also has a 45-minute per-attempt deadline and up to three attempts per shard; authoring and verification rounds each request two hours.

### E2B

E2B is a generation backend only; choose Docker or Modal for Harbor. It requires a custom, prebuilt SelfBench template. Stock E2B templates do not contain the pinned Pi, GitHub CLI, system packages, or `/work` layout that SelfBench expects, so `SELFBENCH_E2B_TEMPLATE` has no default. SelfBench never installs those runtime dependencies while allocating a sandbox.

#### Build the template

Create an E2B API key, export it only in the shell that performs setup, and choose a versioned template name or tag:

```bash
export E2B_API_KEY=...
# Optional only for an E2B-compatible private/control-plane domain:
# export E2B_DOMAIN=e2b.example.com

self-bench setup e2b --name selfbench-runtime:v1
```

This noninteractive command uses the pinned `e2b@2.46.0` SDK to parse the packaged `Dockerfile.sandbox` with the package root as its file context, then calls `Template.build`. It does not require the E2B CLI or a local Docker daemon. Setup accepts a lowercase `name[:tag]` (letters, digits, hyphens, and underscores, plus periods in a tag) and rejects malformed names before any SDK call. The Dockerfile pins its base image and tool versions, supplies an `amd64` default for E2B's `TARGETARCH` parser, and ends at `WORKDIR /work`. Build requests have a 60-second per-request control-plane timeout while the build itself may run longer. Build logs go to stderr; on success the command prints JSON containing the exact template reference returned by E2B, template ID, build ID, and a shell-safe `SELFBENCH_E2B_TEMPLATE` export. Preserve the build ID in deployment records and use a new versioned name/tag when rebuilding so run metadata can identify the intended runtime reference; a mutable tag is not an immutable build identifier.

A standard SelfBench request expects 4 CPUs and 8,192 MiB. E2B 2.46 assigns CPU and memory when the template is built and exposes no per-sandbox resource override. Setup therefore uses those values by default:

```bash
self-bench setup e2b \
  --name selfbench-runtime:v1 \
  --cpus 4 \
  --memory-mib 8192
```

The executor verifies E2B's allocated CPU and memory before uploading source files and fails with a resource-mismatch diagnostic if the configured template differs from the request. Change the setup resource flags only for a custom caller that also sets matching `SandboxRequest` resources; ordinary SelfBench activities use the standard values. Disk size is likewise template/platform controlled and cannot be mapped per create by this SDK version.

E2B templates are durable account resources and are not removed by `self-bench down`. Build a new versioned template for runtime changes and retire old templates according to your E2B retention policy. Each workflow stage still gets a fresh sandbox from that template.

#### Start a worker

Configure the template reference printed by setup, keep the API key in the worker environment, and explicitly choose Harbor:

```bash
export E2B_API_KEY=...
export SELFBENCH_E2B_TEMPLATE=selfbench-runtime:v1
# Optional; defaults to the Hobby-compatible one-hour ceiling:
export SELFBENCH_E2B_TIMEOUT_CAP=1h

self-bench up --backend e2b --harbor-environment docker
# Or, with Modal credentials/profile configured:
# self-bench up --backend e2b --harbor-environment modal
```

Worker startup calls `Template.exists` with an explicit SDK client and a 30-second local/request timeout, and fails before polling Temporal if the credentials cannot access the template. The default activity concurrency is four. Reduce `SELFBENCH_ACTIVITY_CONCURRENCY`, often to `1`, when Docker Harbor or the E2B account cannot sustain four concurrent activities.

E2B Hobby sandboxes have a one-hour maximum lifetime; paid plans can support up to 24 hours. SelfBench conservatively defaults `SELFBENCH_E2B_TIMEOUT_CAP` to `1h`. Set a larger cap only after verifying the account entitlement; values above `24h` are rejected. Discovery requests 45 minutes and each authoring or verification round requests two hours, so the configured cap centrally shortens only longer stages. E2B also receives the effective stage timeout with lifecycle action `kill`, and SelfBench independently enforces the same hard deadline, returning exit 124 after a confirmed cleanup.

Commands run under `/work`. Inputs and binary outputs are transferred with E2B's file API, and paths outside `/work` are rejected before allocation. Stdout/stderr stream progress while retaining only the latest 8 MiB per stream for diagnostics. Output inactivity cancels the command and sandbox. Workload environment and stage secrets are scoped to the command; SelfBench does not create durable account-level E2B Secrets.

Every normal completion, command failure, cancellation, inactivity timeout, and hard timeout enters cleanup. On failure or termination, SelfBench requests command kill first, collects requested partial outputs in parallel under one bounded diagnostic deadline, and only then removes the sandbox. It first tries the sandbox handle, but never treats E2B's `kill(false)` alone as proof of absence: it falls back to static kill by sandbox ID and uses `getInfo`; only `SandboxNotFoundError` independently confirms that the sandbox is gone. Cleanup calls and retries share a bounded deadline, and a stuck provider promise cannot hold the activity open indefinitely.

A create request carries unique SelfBench allocation metadata. If cancellation, timeout, or response loss leaves creation ambiguous before an ID is returned, cleanup searches all listed states (including paused sandboxes) by that metadata and also accepts a late-arriving create handle. If allocation absence or deletion cannot be confirmed within the cleanup window, the activity fails with the allocation context rather than silently reporting success. A provider could still allocate after that bounded recovery window; E2B's requested `onTimeout: kill` lifecycle is the final bound. A worker process crash can likewise bypass client cleanup.

All `E2B_*` variables are treated as control-plane values. Compose passes the supported API key/domain settings only to the worker, not the API, and SelfBench strips the entire prefix from E2B workload commands and Harbor child environments. The API receives only `SELFBENCH_E2B_TEMPLATE` and `SELFBENCH_E2B_TIMEOUT_CAP` so it can stamp run/export metadata. The sandbox still receives repository content and the selected model/GitHub workload credentials, so use only trusted repositories and apply E2B account budget and network controls before unattended runs.

Common failures:

- `E2B template ... does not exist or is not accessible` at worker startup means the name/tag is wrong, the API key belongs to another account, or the optional domain is wrong. Re-export the exact `configure` value from setup or rebuild the template.
- A resource-mismatch error means the template was built with CPU or memory that does not match the stage request. Rebuild the standard template with 4 CPUs and 8,192 MiB.
- A timeout-limit error after raising the cap means the E2B plan does not support that lifetime. Restore `SELFBENCH_E2B_TIMEOUT_CAP=1h` or use a verified paid-plan value.
- A cleanup error includes the sandbox ID or allocation context but redacts the API key. Inspect active sandboxes in E2B, kill any matching `selfbench_allocation` metadata, then resolve control-plane access before retrying.

### Vercel Sandbox

Vercel is a generation backend only; choose Docker or Modal for Harbor. SelfBench supports both Vercel's 45-minute Hobby Sandbox ceiling and the longer paid-team ceiling. Discovery requests 45 minutes and each authoring or verification round requests two hours; setup detects the selected project's effective capability and caps every Vercel stage centrally when necessary. Sandbox use, VCR storage, memory, active CPU, and data transfer are metered by Vercel; configure Spend Management before unattended runs. Vercel Hobby use is intended for personal, non-commercial work.

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

The setup probe records a two-hour effective SelfBench ceiling when the requested two-hour sandbox is accepted. If Vercel returns its exact 45-minute limit response, setup verifies a 45-minute sandbox, explains the impact, and asks before saving that cap. Longer authoring and verification rounds then run for at most 45 minutes and return exit 124 on timeout, so only the affected round fails. Discovery retains its shorter requested limit. The effective cap is included in run and export metadata.

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

The CLI collects sanitized user messages from Pi, Claude Code, and Codex sessions associated with the checkout or its worktrees, then uploads that local corpus with the run request. The workflow starts by running a Temporal activity on the worker that fetches exact titles and bodies from up to 500 recent merged pull requests by non-bot authors that clear coarse tier-appropriate size thresholds. It stores the combined local and GitHub corpus as a run artifact before discovery begins.

GitHub records remain labeled `github-pull-request` and are bound to their own repository, PR number, and canonical URL. Local requests are preferred when they clearly describe the same change. A run can proceed with only local or only GitHub provenance, but fails when the combined corpus is empty. Common credential forms and injected harness context are removed, but this is not a general secret scanner.

### Explicit local-session association

Use an optional local association manifest when you know which coding session produced a merged PR and do not want remote discovery to infer that correspondence. First list the sanitized sessions found for the repository and all of its worktrees:

```bash
self-bench associate --repo /absolute/path/to/repository --list-sessions
```

The newest sessions appear first. The listing contains source type, session ID, retained user-message count, the local session file path (with the home directory abbreviated as `~`), and its filesystem modification timestamp. These fields stay in terminal output only: they are not written to the association manifest or uploaded. Request text is never printed. Treat paths and timestamps as private metadata, and redirect the listing only to a protected file if it must be saved. Select one or more complete sessions and bind them to one merged PR:

```bash
self-bench associate \
  --repo /absolute/path/to/repository \
  --pr 123 \
  --session pi:01a03611-1df5-7f46-a88e-e24f4987b745 \
  --session claude-code:9dd842c0-59d8-4838-8f29-cff97820f4e8 \
  --output ./pr-123-sessions.json
```

`associate` calls `gh pr view` to verify that the PR is merged and belongs to the repository. It then writes the output with create-only semantics and owner-only permissions. The manifest is deterministic and text-free: it contains the repository, canonical PR identity, each selected local message identity, and a SHA-256 of the exact sanitized and whitespace-normalized content SelfBench retains. It does **not** contain request text, upload anything, mutate the repository, or start a run. Keep it private anyway because session identifiers and PR associations can be sensitive.

Pass one or more manifests explicitly when starting a run:

```bash
self-bench run \
  --repo /absolute/path/to/repository \
  --association ./pr-123-sessions.json \
  --easy-count 5 \
  --medium-count 10 \
  --hard-count 5 \
  --output ./self-bench-tasks.tar.gz
```

The run command re-collects, whitespace-normalizes, and sanitizes local sessions, validates the manifest's repository and the complete selected-session snapshot, then annotates the exact retained messages before the existing provenance upload. Changed, added, or missing messages, cross-repository manifests, duplicate bindings, and one message associated more than once fail locally before upload. Unassociated local messages retain the existing discovery behavior only for PRs without explicit associations. On the worker, an explicit local association suppresses the GitHub title/body fallback for that PR, and materialization rejects any attempt to pair that PR with an unbound local message. The API, run request, and artifact reference contracts do not change; the existing sanitized provenance NDJSON is how the worker consumes the optional binding.

Association is deliberately a user assertion, not an LLM decision. Only the local CLI can see the local session stores. An LLM would make the binding nondeterministic, expose more request text, and could invent a correspondence. Remote model discovery can still rank candidates, but materialization resolves an exact retained message and enforces the explicit PR binding.

```bash
self-bench run \
  --repo /absolute/path/to/repository \
  --easy-count 5 \
  --medium-count 10 \
  --hard-count 5 \
  --model gpt-5.6-sol \
  --output ./self-bench-tasks.tar.gz
```

The three tier counts total 1–10,000. Each is an accepted-task target: discovery expands until it can fill every tier and over-fetches a small pool, and a rejected or infrastructure-failed candidate is replaced from that leftover pool until each tier is filled or the pool is exhausted. Accepted tasks are then exported.

### Replaying known candidates

`self-bench replay` starts a run from candidates of an earlier run instead of discovery, for example to re-run a few previously rejected candidates through the current pipeline:

```bash
self-bench replay \
  --source-run sb-20260901-abcd1234 \
  --candidate w0s2-uploader --candidate w1s0-legacy \
  --output ./replayed-tasks.tar.gz
```

The worker rebuilds each candidate from the source run's artifacts: the retained human request from `runs/<source>/provenance/<candidate>.json`, the full candidate record from the discovery `report.json` located through the `w<wave>s<shard>-` ID prefix, or, failing that, the authored `definition.json` plus a `gh pr view` lookup of the completed commit. Candidate IDs are kept, artifacts are written under the new run ID, and authoring and verification start from fresh agent sessions. The same request shape is accepted by `POST /v1/runs` as a `replay` field (`{ "sourceRunId", "candidateIds" }`) in place of `repository`, `provenance`, and `candidateCounts`.

`--output` implies `--wait`. It reports phase changes, requires a successful Temporal terminal state, downloads with create-only filesystem semantics, and verifies the API-provided SHA-256.

A custom `--run-id` must contain 3–63 lowercase letters, digits, or hyphens and start with a letter or digit.

## HTTP API

The CLI is the recommended client. The API exposes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness check |
| `POST` | `/v1/provenance?runId=...` | Store sanitized provenance JSONL |
| `POST` | `/v1/runs` | Start a tiered candidate workflow, or a replay of known candidates |
| `GET` | `/v1/runs` | List workflows |
| `GET` | `/v1/runs/:runId` | Read progress and rejection reasons |
| `POST` | `/v1/runs/:runId/cancel` | Request Temporal cancellation |
| `GET` | `/v1/runs/:runId/export` | Download a completed export |

`/healthz` is unauthenticated. Every other route requires `Authorization: Bearer $SELFBENCH_API_TOKEN` when the token is configured. Startup fails if the API binds beyond loopback without a token.

Run status includes its phase, accepted/rejected counts, per-candidate status with the current stage (`authoring` or `verification`) and round, discovery wave, completed/failed shard counts, and current candidates. Failed generation runs use a new run ID. Run exported tasks directly with Harbor; Harbor owns evaluation result persistence and retry behavior.

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
| `SELFBENCH_EXECUTION_BACKEND` | `docker` | Worker; `docker`, `modal`, `vercel`, or `e2b` |
| `SELFBENCH_DOCKER_IMAGE` | `selfbench-sandbox:local` | Docker worker |
| `SELFBENCH_HARBOR_ENVIRONMENT` | matching Docker/Modal backend | Worker; required as `docker` or `modal` for Vercel/E2B |
| `SELFBENCH_ACTIVITY_CONCURRENCY` | `1` Docker, `20` Modal, `4` Vercel/E2B | Worker |
| `SELFBENCH_MODAL_APP` | `selfbench` | Modal worker |
| `SELFBENCH_MODAL_ENVIRONMENT` | — | Modal worker |
| `SELFBENCH_MODAL_IMAGE` | `node:22-bookworm` | Modal worker |
| `SELFBENCH_MODAL_CONFIG_PATH` | `/dev/null` | Compose host mount; set by `self-bench up --modal-config` locally |
| `SELFBENCH_VERCEL_IMAGE` | profile or — | Required digest-pinned VCR image for Vercel execution |
| `SELFBENCH_VERCEL_TIMEOUT_CAP` | `2h` | Vercel worker and API; accepts integer milliseconds or `ms`, `s`, `m`, `h` units |
| `SELFBENCH_E2B_TEMPLATE` | — | Required E2B template name/tag/ID for API and worker |
| `SELFBENCH_E2B_TIMEOUT_CAP` | `1h` | E2B worker and API; accepts integer milliseconds or `ms`, `s`, `m`, `h` units, up to `24h` |
| `E2B_API_KEY` | — | Worker-only E2B control credential; required for E2B workers |
| `E2B_DOMAIN` | E2B default | Optional worker-only E2B control-plane domain |
| `SELFBENCH_CONFIG_DIR` | `~/.selfbench` | Local CLI profile directory; not needed with a complete Vercel environment |
| `VERCEL_TOKEN` | profile or unset | Vercel worker; explicit project-scoped access token |
| `VERCEL_TEAM_ID` | profile or unset | Vercel worker |
| `VERCEL_PROJECT_ID` | profile or unset | Vercel worker; must be able to resolve the configured image |
| `SELFBENCH_TEMPORAL_ADDRESS` | `127.0.0.1:7233` | API and worker |
| `SELFBENCH_TEMPORAL_NAMESPACE` | `default` | API and worker |
| `SELFBENCH_TASK_QUEUE` | `selfbench-dev` | API and worker |
| `OPENAI_API_KEY` | — | Worker sandboxes |
| `SELFBENCH_PI_AUTH_JSON` | — | Optional Pi `openai-codex` subscription credential |
| `GH_TOKEN` | — | Worker GitHub reads |

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

For E2B generation on a long-running worker, replace the execution settings above with:

```text
SELFBENCH_EXECUTION_BACKEND=e2b
SELFBENCH_HARBOR_ENVIRONMENT=docker  # or modal
SELFBENCH_E2B_TEMPLATE=selfbench-runtime:v1
SELFBENCH_E2B_TIMEOUT_CAP=1h         # raise only to a verified plan limit
E2B_API_KEY=...
# E2B_DOMAIN=...                     # only for a custom E2B domain
```

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
- Sandboxes receive only the selected model credential: `OPENAI_API_KEY` by default, or the isolated Pi `openai-codex` credential when subscription authentication is configured.
- Sandboxes contain both a source checkout and a short-lived model credential. Use SelfBench only with repositories you trust to execute; it is not a malware-analysis service.
- Docker uses disposable containers and volumes and removes them after normal completion. A host crash can leave resources for an operator to inspect and remove. Modal uses disposable Sandboxes. Vercel uses nonpersistent named sandboxes, attempts permanent deletion after each run, and fails the activity when deletion cannot be confirmed; inspect the project after worker crashes or cleanup failures.
- Vercel and E2B control credentials authenticate only the worker's sandbox control plane. Compose does not pass them to the API; `harborChildEnvironment` strips them before Harbor starts, and the E2B executor strips them from workload command environments. They are never workload secrets.
