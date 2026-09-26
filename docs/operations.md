# Operations and deployment

This document covers SelfBench configuration, persistence, authentication, the HTTP API, and cloud deployment. Start with the repository [README](../README.md) for the shortest local workflow.

## Local stack

`docker compose up -d --build` from a checkout starts:

- Postgres for Temporal state;
- Postgres for the site (`site-postgres`: users, connected repos, evaluation records);
- Temporal;
- the SelfBench API, serving the `dist/review` bundle;
- the SelfBench worker;
- a persistent artifact volume.

Add `--profile sandbox` when using Docker generation so Compose also builds `selfbench-sandbox:local`. The worker mounts the host Docker socket for local sandboxes. The API never receives the Docker socket or model credentials; the worker never receives the GitHub OAuth secret or session secret. The local Postgres users and passwords are development defaults (`temporal`/`temporal` and `selfbench`/`selfbench`).

Compose names the project after the checkout directory, so several worktrees run side by side with their own containers, volumes, and image tags. Host ports are ephemeral (`127.0.0.1::<container port>`); resolve them with `docker compose port api 8080` and `docker compose port temporal 7233`. Set `SELFBENCH_PUBLIC_URL` to the origin browsers open **before** `up` — a reverse-proxy or tunnel hostname, not the ephemeral compose port. Recreating the API to pick up a `docker compose port` value would assign a new host port, so that value cannot stay correct. GitHub loopback OAuth can list `http://127.0.0.1/auth/github/callback` (no port).

Older local stacks used the fixed project name `selfbench` and volumes `selfbench_temporal-postgres`, `selfbench_site-postgres`, and `selfbench_artifacts`. A checkout directory named `self-bench` now becomes project `self-bench` and would otherwise start empty. Keep the existing volumes with `COMPOSE_PROJECT_NAME=selfbench docker compose up -d --build`.

Compose reads `.env` from the checkout; copy `.env.example` to start. Keep `.env` free of per-stack values (public URL) when it is shared between worktrees, and export those in the shell instead. With `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, and `SELFBENCH_SESSION_SECRET` set, the API serves the signed-in selfbench.dev site (see [Site sign-in](#site-sign-in-selfbenchdev)); without them it serves the bearer-token Harbor Ledger.

Manage development DNS and reverse proxies with your local tooling. Set `SELFBENCH_PUBLIC_URL` to the externally reachable origin.

Temporal, site, and artifact state live in the `<project>_temporal-postgres`, `<project>_site-postgres`, and `<project>_artifacts` volumes. Back up those volumes before an upgrade when workflow history, users, or generated artifacts must be retained. Site database migrations (`drizzle/`) run automatically when the API or worker starts.

## Credentials

self-bench requires GitHub and model credentials:

- `gh auth login` supplies read access to merged pull requests. Export `GH_TOKEN="$(gh auth token)"` for the worker. Write access is not required. Site generation instead uses the submitter's GitHub OAuth token per run; hosted workers have no `GH_TOKEN` of their own.
- Model credentials come from the site: managed platform access (`SELFBENCH_MANAGED_OPENROUTER_API_KEY`) or a stored organization credential chosen under Advanced Settings → My Credentials. Generation sandboxes never see the worker's own provider environment.

Self-managed workers (started outside Compose, e.g. the cloud topology below) may instead hold `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENROUTER_API_KEY` in their own environment; a managed platform key is the last resort before the host's ChatGPT subscription. For ChatGPT subscription authentication on such a worker, provide `SELFBENCH_PI_AUTH_JSON` containing Pi's `openai-codex` OAuth credential. API-key authentication takes precedence when a key variable is set. SelfBench does not install or invoke the Codex CLI; exported-task evaluation credentials belong to Harbor.

Sandbox-provider credentials are separate. Modal accepts its mounted profile or token pair. Vercel workers use `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID` environment variables. E2B workers use `E2B_API_KEY` and optionally `E2B_DOMAIN`; The E2B template script reads the same values but does not save them. Keep provider credentials on the worker. The API receives provider/template metadata for run manifests but never needs Vercel or E2B control credentials.

### Moving stored credentials to their tables (one time)

Organization credentials and evaluation comparisons used to live inside encrypted per-account blobs in `evaluation_records`. They now live in the `credentials` table (one row per credential, secret column sealed with `SELFBENCH_EVAL_CREDENTIAL_KEY`) and the `comparisons` table. Migration `0010_credentials_and_comparisons` creates the empty tables; `src/db/records-migration.ts` copies the data. It keeps every credential and comparison ID, maps personal accounts to the user's personal organization, records deleted credentials as soft-deleted rows without a secret, and skips IDs already copied, so it is safe to rerun. It never deletes the source records, so rolling the code back needs no data restore (credentials added after the cutover exist only in the new tables).

Run it only with a separate deployment authorization, against the database the API uses:

1. Stop new submissions: stop the API and worker (`docker compose stop api worker`, or the equivalent for your topology). Credentials created between the copy and the cutover would otherwise be missed.
2. Take a database backup.
3. Dry run from the new release's API image, which already carries `SELFBENCH_DATABASE_URL` and `SELFBENCH_EVAL_CREDENTIAL_KEY`: `docker compose run --rm --no-deps api node dist/db/records-migration.js`. It applies pending schema migrations, then prints counts of accounts, live and deleted credentials, comparisons, and any skipped accounts. It writes no rows. It never prints secrets.
4. Apply: the same command with `--apply`. Rerun the dry run and confirm the counts match `select count(*) from credentials` and `select count(*) from comparisons`.
5. Start the API and worker on the new release. Spot-check **Settings → Credentials** and **Results → comparisons** for one organization.

The old `accounts/…` and `credentials/…` records can be deleted in a later release once the new tables are confirmed. Generation run records (`generations/<runId>`) and managed E2B template locks stay in `evaluation_records`.

### Recomputing a finished evaluation's trial costs

Trial cost (`modelVerified`, `tokenUsage`, `apiCostUsd`, `costSource`) is derived once, when a trial finishes. After a cost fix ships, older runs keep their stored values until recomputed from their saved Harbor artifacts (`trajectory.json` or `pi.txt`, and `result.json`):

```bash
docker compose run --rm --no-deps api node dist/evaluation/recompute-cost.js <repoId> <evaluationId>          # dry run
docker compose run --rm --no-deps api node dist/evaluation/recompute-cost.js <repoId> <evaluationId> --apply  # save
```

The dry run prints each trial's stored and recomputed cost fields and writes nothing. `--apply` appends a new evaluation snapshot with only the cost fields changed; earlier snapshots stay in the artifact store, so the prior revision remains readable. It refuses runs that are still queued or running.

## Execution backends and Harbor

SelfBench uses one provider for discovery, authoring-turn, and review-round sandboxes. Every generation provider runs the same runtime, defined by `Dockerfile.sandbox`: Docker runs the image Compose builds from it, Modal and E2B build from the packaged file automatically, and Vercel runs an image published from it (see below). It separately invokes Harbor for the build, smoke, nop, and oracle gates of every `verify` and every submission. Every generation backend defaults Harbor to the matching environment; `SELFBENCH_HARBOR_ENVIRONMENT=docker|modal|vercel|e2b|daytona` selects a different one. Daytona is a Harbor-only environment and reads `DAYTONA_API_KEY` from the worker. The pinned Harbor build is installed with its `e2b`, `daytona`, `modal`, and `vercel` extras; Harbor's Vercel environment boots a Vercel Sandbox from a cached snapshot and runs Docker inside it.

```bash
SELFBENCH_EXECUTION_BACKEND=docker docker compose --profile sandbox up -d --build   # Docker + Docker
SELFBENCH_EXECUTION_BACKEND=modal docker compose up -d --build                      # Modal + Modal
SELFBENCH_EXECUTION_BACKEND=vercel SELFBENCH_HARBOR_ENVIRONMENT=docker docker compose up -d --build
SELFBENCH_EXECUTION_BACKEND=vercel SELFBENCH_HARBOR_ENVIRONMENT=modal docker compose up -d --build
SELFBENCH_EXECUTION_BACKEND=vercel docker compose up -d --build                     # Vercel + Vercel
SELFBENCH_EXECUTION_BACKEND=vercel SELFBENCH_HARBOR_ENVIRONMENT=e2b docker compose up -d --build
SELFBENCH_EXECUTION_BACKEND=vercel SELFBENCH_HARBOR_ENVIRONMENT=daytona docker compose up -d --build
SELFBENCH_EXECUTION_BACKEND=e2b docker compose up -d --build                        # E2B + E2B
SELFBENCH_EXECUTION_BACKEND=e2b SELFBENCH_HARBOR_ENVIRONMENT=docker docker compose up -d --build
SELFBENCH_EXECUTION_BACKEND=e2b SELFBENCH_HARBOR_ENVIRONMENT=modal docker compose up -d --build
SELFBENCH_EXECUTION_BACKEND=docker SELFBENCH_HARBOR_ENVIRONMENT=modal docker compose --profile sandbox up -d --build
SELFBENCH_EXECUTION_BACKEND=modal SELFBENCH_HARBOR_ENVIRONMENT=docker docker compose up -d --build
SELFBENCH_EXECUTION_BACKEND=modal SELFBENCH_HARBOR_ENVIRONMENT=daytona docker compose up -d --build
```

### Managed generation

Setting `SELFBENCH_MANAGED_OPENROUTER_API_KEY` and `SELFBENCH_MANAGED_E2B_API_KEY` plus optional `SELFBENCH_MANAGED_E2B_DOMAIN` (all shared between the API and worker) offers managed model access and managed sandboxes: generation runs on SelfBench's own accounts instead of an organization credential, and every stage's token usage and sandbox seconds are metered into the `generation_usage` table. USD columns are estimates for the UI. Invoice quantities are integer billable units computed from a frozen rate snapshot (token counts and sandbox seconds × snapshot rates), never from those floats. Each managed capability is offered exactly when its platform key is set; there is no separate flag. Managed E2B templates are built on first use under the `platform` lock and shared across organizations. Managed runs verify with Harbor on the platform Modal account when `SELFBENCH_MANAGED_MODAL_TOKEN_ID` and `SELFBENCH_MANAGED_MODAL_TOKEN_SECRET` are set (optionally scoped by `SELFBENCH_MANAGED_MODAL_ENVIRONMENT`), because Harbor's E2B environment does not run a task's Docker Compose services; without them, managed verification falls back to E2B. The choice is recorded on the run at creation, so the API and worker must share these keys. Users can still select their own credentials under Advanced Settings; metering then records usage without billable units or a cost figure.

### Stripe metered billing

Managed usage is the only SelfBench-billable usage. Organization credentials stay provider-billed. Billing is optional: leave `SELFBENCH_STRIPE_SECRET_KEY`, `SELFBENCH_STRIPE_WEBHOOK_SECRET`, and `SELFBENCH_STRIPE_PRICE_ID` unset to keep managed runs available without invoicing. Setting only some of those three fails API startup. Compose keeps the Stripe secrets on the API; generation and export never call Stripe. They write `generation_usage` and, when the org already has a Stripe customer, a `billing_outbox` row in the same transaction. The API delivers [Billing Meter Events v2](https://docs.stripe.com/api/v2/billing/meter-event) with identifier `selfbench-usage-{usage id}`.

Create a Stripe Billing Meter whose event name matches `SELFBENCH_STRIPE_METER_EVENT_NAME` (default `selfbench_managed_usage`) and a metered price on that meter. Point `SELFBENCH_STRIPE_PRICE_ID` at that price. The webhook endpoint is `POST /api/stripe/webhook` (signature-verified, unauthenticated). Local Compose stacks are not reachable from Stripe, so webhooks go through the `stripe` profile (`docker compose --profile stripe up -d`), which runs Stripe CLI, stores its generated signing secret in a private Compose volume, and forwards to `http://api:8080/api/stripe/webhook`; no manual webhook-secret copy is needed. Production should register a Dashboard endpoint at the public origin instead of the CLI. Org admins start Checkout and the Customer Portal from **Settings → Billing**. New managed runs require an `active` or `trialing` subscription when Stripe is configured; `past_due` and missing subscriptions are refused. In-flight usage still enqueues if a customer id already exists.

Pricing policy is explicit and integer: `SELFBENCH_BILLING_UNIT_SCALE` (default `10000000`, so one unit is $1e-7) and `SELFBENCH_BILLING_MARKUP_BPS` (default `0`, pass-through of published OpenRouter/E2B rates). There is no free allowance and no spending cap. Model and sandbox units share one meter. Historical usage recorded while Stripe was off is never backfilled.

The hosted site offers only Modal, Vercel, and E2B generation with Modal, Vercel, E2B, or Daytona Harbor, each backed by an organization credential. Docker is not offered there because Docker generation and Docker Harbor both run on the shared worker. Hosted Harbor credentials travel as `SELFBENCH_HARBOR_E2B_API_KEY` and `SELFBENCH_HARBOR_VERCEL_TOKEN`, `SELFBENCH_HARBOR_VERCEL_TEAM_ID`, and `SELFBENCH_HARBOR_VERCEL_PROJECT_ID`, and take their provider names only inside Harbor's process, so generation and verification may use different accounts of the same provider. The hosted worker has no `GH_TOKEN`: when a signed-in user starts a batch or PR task, the API stores that user's GitHub OAuth token in the encrypted record store beside the run's generation settings, and `generationEnvironment()` injects it as `GH_TOKEN` for provenance collection, discovery, authoring, and verification of that run only.

Set `SELFBENCH_MODAL_CONFIG_PATH` whenever either side uses Modal. A worker has one fixed pairing; do not run workers with different provider settings on the same Temporal task queue. Run and export metadata record both choices, plus the configured hosted-provider timeout cap when applicable.

### Docker

Build the worker's sandbox image once:

```bash
docker compose --profile sandbox up -d --build
```

Docker defaults to one activity at a time because sandboxes share the host. Each candidate defaults to 4 CPUs, 8,192 MB RAM, and 20,480 MB storage. Authored tasks may request other positive limits.

### Modal

Authenticate Modal and mount its profile into the worker:

```bash
modal token new

SELFBENCH_EXECUTION_BACKEND=modal SELFBENCH_MODAL_CONFIG_PATH="$HOME/.modal.toml" docker compose up -d --build

# If your profile is not at ~/.modal.toml:
SELFBENCH_EXECUTION_BACKEND=modal SELFBENCH_MODAL_CONFIG_PATH=/absolute/path/to/.modal.toml docker compose up -d --build
```

Modal sandboxes are built from the packaged `Dockerfile.sandbox`: its pinned `FROM` image, then its remaining instructions replayed as Modal Dockerfile commands. Modal caches the resulting image, so it rebuilds only when the file changes, and run metadata records the file's content hash as `Dockerfile.sandbox@<hash>`.

Compose bind-mounts `SELFBENCH_MODAL_CONFIG_PATH` into the worker at `/root/.modal.toml`; the default is `/dev/null` so a missing profile file does not break Docker-only stacks. Set the variable to an absolute path whenever generation or Harbor uses Modal. A secret manager may provide `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` instead. Empty token environment variables are removed at worker startup so they cannot override a valid mounted profile.

Modal defaults to 20 concurrent worker activities; hosted provider settings remain provider-specific. SelfBench-owned execution safety limits are 300 candidates per run, 150 candidate workflows in a fanout, and eight discovery shards. Activities that spawn `harbor run` (Harbor gates in `compileAndVerify` and solver trials) poll a sibling queue, `<task queue>-harbor`, with its own slot count: each Harbor process is a Python client peaking near 105 MiB with Harbor telemetry disabled, and a solver trial also unpacks its task bundle into memory-backed `/tmp`, so `SELFBENCH_HARBOR_CONCURRENCY` is memory-sized but capped at 10 and never takes an ordinary slot from authoring or review sessions. Discovery, authoring rounds, and review rounds stop after eight minutes without process output. Discovery also has a 45-minute per-attempt deadline and up to three attempts per shard; authoring turns and review rounds each request four hours.

### E2B

E2B generation defaults to E2B Harbor; choose Docker, Modal, Vercel, or Daytona instead with `SELFBENCH_HARBOR_ENVIRONMENT`. Sandboxes must run a custom SelfBench template: stock E2B templates do not contain the pinned Pi, GitHub CLI, system packages, or `/work` layout that SelfBench expects. Hosted generation manages this automatically — the worker builds a template named `selfbench-runtime:<dockerfile-hash>` in the run's E2B account from the packaged `Dockerfile.sandbox` the first time a run needs it, and reuses it after (an encrypted record serialises concurrent builds, and a lock left by a crashed worker is taken over after 45 minutes). Self-hosted stacks can rely on the same managed template or build their own with `bun scripts/build-e2b-template.ts` from a checkout and export `SELFBENCH_E2B_TEMPLATE`; SelfBench never installs runtime dependencies while allocating a sandbox.

#### Build the template

Create an E2B API key, export it only in the shell that performs setup, and choose a versioned template name or tag:

```bash
export E2B_API_KEY=...
# Optional only for an E2B-compatible private/control-plane domain:
# export E2B_DOMAIN=e2b.example.com

bun scripts/build-e2b-template.ts --name selfbench-runtime:v1
```

This noninteractive command uses the pinned `e2b@2.46.0` SDK to parse the packaged `Dockerfile.sandbox` with the package root as its file context, then calls `Template.build`. It does not require the E2B CLI or a local Docker daemon. Setup accepts a lowercase `name[:tag]` (letters, digits, hyphens, and underscores, plus periods in a tag) and rejects malformed names before any SDK call. The Dockerfile pins its base image and tool versions, supplies an `amd64` default for E2B's `TARGETARCH` parser, and ends at `WORKDIR /work`. Build requests have a 60-second per-request control-plane timeout while the build itself may run longer. Build logs go to stderr; on success the command prints JSON containing the exact template reference returned by E2B, template ID, build ID, and a shell-safe `SELFBENCH_E2B_TEMPLATE` export. Preserve the build ID in deployment records and use a new versioned name/tag when rebuilding so run metadata can identify the intended runtime reference; a mutable tag is not an immutable build identifier.

A standard SelfBench request expects 4 CPUs and 8,192 MiB. E2B 2.46 assigns CPU and memory when the template is built and exposes no per-sandbox resource override. Setup therefore uses those values by default:

```bash
bun scripts/build-e2b-template.ts \
  --name selfbench-runtime:v1 \
  --cpus 4 \
  --memory-mib 8192
```

The executor verifies E2B's allocated CPU and memory before uploading source files and fails with a resource-mismatch diagnostic if the configured template differs from the request. Change the setup resource flags only for a custom caller that also sets matching `SandboxRequest` resources; ordinary SelfBench activities use the standard values. Disk size is likewise template/platform controlled and cannot be mapped per create by this SDK version.

E2B templates are durable account resources and are not removed by `docker compose down`. Build a new versioned template for runtime changes and retire old templates according to your E2B retention policy. Each workflow stage still gets a fresh sandbox from that template.

#### Start a worker

Configure the template reference printed by setup, keep the API key in the worker environment, and explicitly choose Harbor:

```bash
export E2B_API_KEY=...
export SELFBENCH_E2B_TEMPLATE=selfbench-runtime:v1
# Optional; defaults to the Hobby-compatible one-hour ceiling:
export SELFBENCH_E2B_TIMEOUT_CAP=1h

SELFBENCH_EXECUTION_BACKEND=e2b SELFBENCH_HARBOR_ENVIRONMENT=docker docker compose up -d --build
# Or, with Modal credentials/profile configured:
# SELFBENCH_EXECUTION_BACKEND=e2b SELFBENCH_HARBOR_ENVIRONMENT=modal docker compose up -d --build
```

Worker startup calls `Template.exists` with an explicit SDK client and a 30-second local/request timeout, and fails before polling Temporal if the credentials cannot access the template. The default activity concurrency is four. Reduce `SELFBENCH_ACTIVITY_CONCURRENCY`, often to `1`, when Docker Harbor or the E2B account cannot sustain four concurrent activities.

E2B Hobby sandboxes have a one-hour maximum lifetime; paid plans can support up to 24 hours. SelfBench conservatively defaults `SELFBENCH_E2B_TIMEOUT_CAP` to `1h`. Set a larger cap only after verifying the account entitlement; values above `24h` are rejected. Discovery requests 45 minutes and each authoring turn or review round requests four hours, so the configured cap centrally shortens only longer stages. Because every `verify` ends the authoring turn, the cap bounds a single turn, not the whole round. E2B also receives the effective stage timeout with lifecycle action `kill`, and SelfBench independently enforces the same hard deadline, returning exit 124 after a confirmed cleanup.

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

Vercel generation defaults to Vercel Harbor; choose Docker, Modal, E2B, or Daytona instead with `SELFBENCH_HARBOR_ENVIRONMENT`. SelfBench supports both Vercel's 45-minute Hobby Sandbox ceiling and the longer paid-team ceiling. Discovery requests 45 minutes and each authoring or review round requests four hours; `SELFBENCH_VERCEL_TIMEOUT_CAP` (default `2h`; use `45m` on Hobby) caps every Vercel stage centrally. Sandbox use, VCR storage, memory, active CPU, and data transfer are metered by Vercel; configure Spend Management before unattended runs. Vercel Hobby use is intended for personal, non-commercial work.

#### Publish the runtime image

Vercel sandboxes run a digest-pinned image built from `Dockerfile.sandbox` and published to the project's Vercel Container Registry (VCR). With the Vercel CLI logged in and Docker available, from a checkout:

```bash
npm install --global vercel@latest
vercel vcr add selfbench-runtime --project "$VERCEL_PROJECT_ID" --scope "$TEAM_SLUG"
vercel vcr login docker --project "$VERCEL_PROJECT_ID" --scope "$TEAM_SLUG"
vercel vcr build docker . selfbench-runtime:v1 --project "$VERCEL_PROJECT_ID" \
  --platform linux/amd64 --push --scope "$TEAM_SLUG" -- --file Dockerfile.sandbox
vercel vcr tag inspect selfbench-runtime v1 --project "$VERCEL_PROJECT_ID" --scope "$TEAM_SLUG" --json
```

Set `SELFBENCH_VERCEL_IMAGE` to the bare repository-plus-digest form (`selfbench-runtime@sha256:...`) from the inspect output, and create a project-scoped access token for `VERCEL_TOKEN`. Publish a new tag whenever `Dockerfile.sandbox` changes. The project does not need a deployment; its metered use is billed to its owning Vercel scope.

#### Start the local worker

```bash
SELFBENCH_EXECUTION_BACKEND=vercel SELFBENCH_HARBOR_ENVIRONMENT=modal docker compose up -d --build
# SELFBENCH_EXECUTION_BACKEND=vercel SELFBENCH_HARBOR_ENVIRONMENT=docker docker compose up -d --build
```

Modal Harbor also needs the Modal profile or token pair. Vercel control credentials are removed from the Harbor child process for both Harbor environments. Export the complete credential triple, digest-pinned image, and timeout cap before starting Compose.

With a 45-minute cap, longer authoring and review rounds run for at most 45 minutes and return exit 124 on timeout, so only the affected round fails. Discovery retains its shorter requested limit. The effective cap is included in run and export metadata.

#### Environment-only and unattended workers

Workers read the Vercel values from environment variables or a secret manager:

```bash
export VERCEL_TOKEN=...
export VERCEL_TEAM_ID=team_...
export VERCEL_PROJECT_ID=prj_...
export SELFBENCH_VERCEL_IMAGE='selfbench-runtime@sha256:...'
export SELFBENCH_VERCEL_TIMEOUT_CAP=2h  # use 45m when that is the verified ceiling

SELFBENCH_EXECUTION_BACKEND=vercel SELFBENCH_HARBOR_ENVIRONMENT=modal docker compose up -d --build
```

The image must already have been published from `Dockerfile.sandbox` to the same project's VCR as `linux/amd64`. Use the bare repository-plus-digest form shown above; tags and rolling aliases are rejected. VCR repositories are project-scoped by default, so a sandbox in another project cannot use the image unless the repository is explicitly shared.

Vercel defaults to four concurrent worker activities. A standard SelfBench sandbox requests 4 vCPUs, which Vercel pairs with 8 GB of memory, plus 32 GB of ephemeral disk. Unsupported CPU/memory combinations are rejected before allocation. Raise `SELFBENCH_ACTIVITY_CONCURRENCY` only after considering the team's allocation limits and budget. Lower it—often to `1`—when using Docker Harbor on a smaller local machine, because the Vercel-oriented default does not account for local Harbor capacity.

Each sandbox run uses a fresh nonpersistent sandbox (`persistent: false`). SelfBench does not create snapshots or resume stopped sandboxes, and it attempts to delete every sandbox when the run ends. If deletion cannot be confirmed, the activity fails so the cleanup problem remains visible. If the worker crashes before cleanup, compute may continue until the provider timeout; Vercel then discards the filesystem, although the stopped sandbox record may remain for up to 14 days unless manually deleted.

Cancel active workflows and let cleanup finish before stopping the stack.

Common failures:

- A newly changed paid plan may take time to propagate its longer timeout entitlement. Keep `SELFBENCH_VERCEL_TIMEOUT_CAP=45m` until it does; if a correctly scoped paid project keeps rejecting longer sandboxes, verify team/project ownership before contacting Vercel Support.
- `not_found` on create usually means the image belongs to another project or is private and unshared. Prefer the same project and a bare digest reference.
- `image_not_ready` means VCR has not finished optimizing the `linux/amd64` image.
- Repeated HTTP 429 allocation failures indicate project/team allocation pressure. The executor honors bounded `Retry-After` retries; reduce activity concurrency if pressure continues.
- Cleanup errors fail the activity rather than silently leaving reusable state and include the exact `selfbench-...` sandbox name for diagnosis.

## Generation runs

Runs start from the web app or its `/api` batch routes (a personal API key works for scripts). The API pins the head of the repository's default branch and lists up to 500 recent merged pull requests with the submitter's GitHub token. Each PR by a non-bot author that clears the coarse size thresholds becomes a provenance record: its title and body, redacted of common credential forms, labeled `github-pull-request`, and bound to its repository, PR number, and canonical URL. Discovery shards propose candidates from those records, and every candidate's request is the exact text of its own PR. "Add PR" skips discovery and authors one chosen PR.

The three tier counts total 1–300. Each is an accepted-task target: discovery expands until it can fill every tier and over-fetches a small pool, and a rejected or infrastructure-failed candidate is replaced from that leftover pool until each tier is filled or the pool is exhausted. Accepted tasks are then exported.

The `self-bench` command only wraps the run API: `list`, `status`, `cancel`, and `download` (which verifies the export's SHA-256 and writes it create-only). Point it at the API with `SELFBENCH_API_URL` and authenticate with `SELFBENCH_API_TOKEN` (the operator token or a personal `sbk_` API key).

Export dedupe rule: the export keeps the first accepted task per source pull request, in the order candidates
were accepted, and drops later ones. The manifest's `acceptedCount` and `tasks` cover only kept tasks;
`droppedDuplicates` lists each dropped task with its `sourcePr` and the `keptTaskId` it duplicates. Run status and
`acceptedTaskIds` still report every accepted candidate; the export is the deduplicated deliverable.

### Round artifacts

Each review round stores its decision under `runs/<runId>/review/<candidateId>/round-<n>/result.json` and each
authoring turn under `runs/<runId>/authoring/<candidateId>/round-<n>/turn-<k>/result.json`; a round's final
outcome is also written to `round-<n>/result.json`. Everything one sandbox attempt produces lives under its
`…/attempt-<m>/` folder, uploaded by the sandbox itself: `prompt.md`, the log (`sandbox.log`, or `modal.log` for
discovery), `session.jsonl`, the redacted live feed under `live/`, the agent's outputs (the handed-off draft, the
verdict, the discovery plan), and `agent.json`, the run's own record (stage, round, turn, attempt, session key,
start and finish) that the agent work sheet lists. A Temporal retry therefore never collides with the immutable
artifacts of the attempt it replaces.

Large request files reach the sandbox by URL rather than upload: the review round asks the artifact store for a V4 signed read URL of the compiled task bundle (two-hour TTL) and the E2B executor has the sandbox `curl` it and verify the SHA-256 in place. Pushing hundreds of MB per sandbox through `files.write` hit the SDK's client-side request timeout once a couple of dozen rounds started together; E2B recommends the pull pattern. Providers without an in-sandbox download step fetch remote files on the worker and upload them inline.

The round wrapper records its own exit status in `/work/wrapper-status` from its EXIT trap, and the worker trusts
that file over the provider's reported exit code (a provider hard timeout stays authoritative). E2B has been
observed to lose a long command's stream after the script finished and report a spurious exit code or a gRPC
"terminated" error; with the status file collected, such a failure becomes a normal round result instead of a retry.

## Task pages

Each task in the web app shows the compiled environment (task.toml, Dockerfiles, services, resources), the setup, smoke, and test commands with the selected tests, the instruction beside the gold and held-out test patches, and a file tree of everything in the bundle. The pipeline sheet lists each stage's artifacts with a one-line summary of what it concluded. The pages read bundles and artifacts through `GET /v1/runs/:runId/bundle` and `GET /v1/runs/:runId/artifacts`.

## HTTP API

The CLI is the recommended client for run workflows. Every site feature is also reachable over HTTP with a personal API key; see the [HTTP API reference](api.md) for the full route list and authentication. The run routes are:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness check |
| `GET` | `/v1/runs` | List workflows |
| `GET` | `/v1/runs/:runId` | Read progress and rejection reasons |
| `POST` | `/v1/runs/:runId/cancel` | Request Temporal cancellation |
| `GET` | `/v1/runs/:runId/export` | Download a completed export |
| `GET` | `/v1/runs/:runId/artifacts?key=...` | Stream one artifact under `runs/:runId/` |
| `GET` | `/v1/runs/:runId/bundle?key=...` | Expand a Harbor task bundle into its text files |

`/healthz` is unauthenticated. Every other route requires `Authorization: Bearer $SELFBENCH_API_TOKEN` when the token is configured. Startup fails if the API binds beyond loopback without a token.

### Sandbox callback API

Sandbox jobs report back through the API instead of holding a worker connection. The API and the worker share `SELFBENCH_SANDBOX_SECRET`, and the worker needs `SELFBENCH_SANDBOX_CALLBACK_URL`: the public origin for hosted sandboxes, or `http://api:8080` for local Docker sandboxes on the compose network (`SELFBENCH_DOCKER_NETWORK`). Both processes refuse to start without them. Every discovery, authoring, review, and compile sandbox runs this way. The worker starts the sandbox detached and completes the activity asynchronously; a small runner in the sandbox (`src/sandbox/programs/job.ts`) runs the command, heartbeats every minute with the model usage so far (priced into the live cost on progress pages), publishes an agent's redacted live feed, kills a command that is silent for eight minutes, uploads the outputs, and reports the result. An agent that ends without delivering its result (a hand-off, a verdict, a plan) after a failed exit, a provider error, or without a session reports `failed`, so Temporal retries the attempt. A follow-up activity then reads the reported references, stops the sandbox, and bills its lifetime and tokens.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/sandbox/uploads` | Where to PUT one output: a signed GCS URL, or `/api/sandbox/files/:name` on the local store |
| `PUT` | `/api/sandbox/files/:name` | Receive an upload (local artifact store only) |
| `POST` | `/api/sandbox/events` | `heartbeat`, `done` (the uploaded files and a small inline result), or `failed` |

Each job authenticates with a grant the worker signs with the shared secret: the Temporal task token of one activity attempt, the one artifact folder it may write, and its sandbox. Nothing is stored server-side. `done` is accepted only for files that exist with the declared SHA-256 and size; the API then completes the activity with their references. A heartbeat to a cancelled, retried, or finished attempt answers `{"continue": false}` and the runner exits. A retried attempt stops the sandbox its predecessor left.

### Site sign-in (selfbench.dev)

Setting `GITHUB_OAUTH_CLIENT_ID` turns the same API into the selfbench.dev site: the bundle in `dist/review` renders the login page and signed-in shell instead of the Harbor Ledger, and these routes appear:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/auth/github` | Redirect to GitHub with a state cookie (scopes `read:user read:org repo`) |
| `GET` | `/auth/github/callback` | Exchange the code, record the user and their org memberships, set the session cookie |
| `POST` | `/auth/logout` | Clear the session cookie |
| `GET` | `/api/me` | The caller's login, name, avatar, organizations, and how they authenticated |
| `*` | `/api/api-keys…` | Personal API keys: list, create (secret shown once), revoke |
| `*` | `/api/orgs/:org/…` | Repositories, tasks, batches, evaluations, comparisons, and credentials; see the [API reference](api.md) |

The session is a signed, HttpOnly, SameSite=Lax cookie valid for 30 days (Secure when `SELFBENCH_PUBLIC_URL` is https). Users live in the `users` table of `SELFBENCH_DATABASE_URL`; migrations run at startup. The user's GitHub token is stored encrypted under a key derived from `SELFBENCH_SESSION_SECRET` and is never sent to the browser. With sign-in enabled, `/v1/*` and `/api/*` answer 401 unless the request carries a valid session, a personal API key (`Authorization: Bearer sbk_…` or `X-API-Key`), or the operator bearer token. API keys are stored as SHA-256 hashes in the `api_keys` table and act as their owner; `read`-scoped keys may only send `GET` requests.

Set `SELFBENCH_ALLOWED_GITHUB_ORGS` (comma-separated logins, case-insensitive) to limit sign-in to active members of those organizations. Non-members are refused at the callback and land on `/login?error=organization`; existing sessions re-verify membership against GitHub with a five-minute cache, and a removed member is denied with `organization_required` instead of waiting for the 30-day cookie to expire. Without the setting, sign-in stays open to everyone.

Compose: put the three sign-in variables in `.env` and set `SELFBENCH_PUBLIC_URL` to the browser-facing origin. Register that origin with `/auth/github/callback` as the GitHub OAuth callback.

Hot-reload loop: `bun run dev:site` starts a Postgres container (`selfbench-site-postgres`, 127.0.0.1:5433), the API on 8087 with `SELFBENCH_TEMPORAL_CONNECT=lazy`, and Vite on 5173 proxying `/v1`, `/api`, and `/auth`. Register a GitHub OAuth app with callback `http://127.0.0.1/auth/github/callback` (GitHub lets loopback redirects use any port, so browse to `http://127.0.0.1:5173`) and put `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, and `SELFBENCH_SESSION_SECRET` in `.env.site`.

Run status includes its phase, accepted/rejected counts, per-candidate status with the current stage (`authoring` or `verification`) and round, discovery wave, completed/failed shard counts, and current candidates. Failed generation runs use a new run ID. Run exported tasks directly with Harbor; Harbor owns evaluation result persistence and retry behavior.

`/v1/runs` also lists runs that exist only in the artifact store (status `ARCHIVED`) once Temporal retention has dropped their workflow. For those runs the candidate routes reconstruct each candidate from its artifacts: the stage is the furthest pipeline group that wrote anything, and a candidate counts as accepted when its latest review round wrote an `accepted` `result.json` (a `rejected` round result in either loop marks the stage that ended it). Runs without round results remain archived and are not inferred as accepted. Bundle expansion caches extracted bundles under the API host's temporary directory, keyed by artifact key, and never returns `repo.tar.gz` contents.

SelfBench has no remote deletion route. Delete local artifact-volume data or GCS run prefixes through normal operator tooling.

## Temporal workflow shape

A batch is not a Temporal workflow. The API's batch reconciler (`src/generation/batches/service.ts`) stores each batch in Postgres, polls every five seconds, and starts independent workflows as the batch advances: one `selfBenchDiscoveryShardWorkflow` per discovery shard, then one `selfBenchAuthorWorkflow` per candidate, which runs that candidate's authoring and review loops and returns its final progress plus the accepted task. The reconciler reads each workflow's result, replaces rejected candidates from the leftover pool, and builds the export once every tier is filled or the pool is exhausted. A cancelled dispatch reserves its workflow ID with the no-op `selfBenchCancelledDispatchWorkflow`.

To inspect one candidate, open its author workflow in the Temporal UI; its history shows that candidate's activities, retries, and timeouts alone, and the `candidateStatus` query returns its current progress.

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
| `SELFBENCH_DOCKER_IMAGE` | `selfbench-sandbox:local` | Docker worker; sandbox image tag built by `docker compose --profile sandbox` |
| `SELFBENCH_HARBOR_ENVIRONMENT` | matching Docker/Modal backend | Worker; required as `docker` or `modal` for Vercel/E2B |
| `SELFBENCH_ACTIVITY_CONCURRENCY` | `1` Docker, `20` Modal, `4` Vercel/E2B | Worker |
| `SELFBENCH_HARBOR_CONCURRENCY` | sized to worker memory, capped at 10 | Worker |
| `SELFBENCH_WORKFLOW_LIMIT` | `100` | API; managed generation workflows (discovery shards and candidates) running at once across the platform; the rest wait in their batch, first come first served |
| `SELFBENCH_MODAL_APP` | `selfbench` | Modal worker |
| `SELFBENCH_MODAL_ENVIRONMENT` | — | Modal worker |
| `SELFBENCH_MODAL_CONFIG_PATH` | `/dev/null` | Compose host mount; set to an absolute `.modal.toml` when using Modal locally |
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
| `SELFBENCH_TEMPORAL_CONNECT` | `eager` | API; `lazy` defers the Temporal connection to first use |
| `GITHUB_OAUTH_CLIENT_ID` | unset | API; enables site sign-in |
| `GITHUB_OAUTH_CLIENT_SECRET` | — | API; required with the client id |
| `SELFBENCH_SESSION_SECRET` | — | API; 32+ characters, signs session cookies and seals GitHub tokens |
| `SELFBENCH_ALLOWED_GITHUB_ORGS` | unset | API; comma-separated GitHub org logins whose active members may sign in |
| `SELFBENCH_PUBLIC_URL` | `http://127.0.0.1:8080` | API; public origin, forms the OAuth callback URL. Set to the assigned host port (`docker compose port api 8080`) or a reverse-proxy hostname |
| `SELFBENCH_RESULTS_SITE_URL` | unset | API; origin of the public results site (prod: `https://selfbench.dev`). Unset, no host serves the site and the Releases tab shows no public link. Requests for its host get the public site (pages, `/api/public`, files) and nothing of the app; the Releases tab links there |
| `SELFBENCH_RESULTS_SITE_INDEX` | unset | API; `true` lets search engines index the results site (prod). Unset sends `noindex` and a disallow-all `robots.txt` |
| `SELFBENCH_DATABASE_URL` | compose: `site-postgres` | API and worker; Postgres holding users, connected repos, and evaluation records |
| `SELFBENCH_EVAL_CREDENTIAL_KEY` | — | API and worker; 32-byte hex key encrypting saved evaluation credentials |
| `SELFBENCH_STRIPE_SECRET_KEY` | unset | API; with webhook secret and price id enables metered billing |
| `SELFBENCH_STRIPE_WEBHOOK_SECRET` | unset | API; required with the secret key |
| `SELFBENCH_STRIPE_PRICE_ID` | unset | API; metered Stripe price attached to the usage meter |
| `SELFBENCH_STRIPE_METER_EVENT_NAME` | `selfbench_managed_usage` | API and worker; Stripe Billing Meter event name |
| `SELFBENCH_BILLING_UNIT_SCALE` | `10000000` | API and worker; integer units per USD |
| `SELFBENCH_BILLING_MARKUP_BPS` | `0` | API and worker; integer basis points added to published rates |
| `OPENAI_API_KEY` | — | Self-managed workers only; Compose stacks authenticate models through managed keys or stored credentials |
| `SELFBENCH_PI_AUTH_JSON` | — | Optional Pi `openai-codex` subscription credential on self-managed workers |
| `GH_TOKEN` | — | Worker GitHub reads; hosted generation uses the submitter's GitHub token instead |
| `DOCKER_GID` | `0` | Compose; group added to the worker so it may use the mounted `/var/run/docker.sock` for Docker sandboxes |

## Cloud topology

For the GCP dev/prod Terraform foundation and GitHub Actions deployment flow, see
[`infra/README.md`](../infra/README.md). The infrastructure code does not provision or deploy itself.

The API is a regular request-oriented HTTP service suitable for Cloud Run. Deploy `Dockerfile` with its default `node dist/api/main.js` command and port 8080:

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
