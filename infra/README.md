# SelfBench Infrastructure

SelfBench runs on a small GCP stack managed with Terraform:

- one isolated project per environment
- the API on Cloud Run behind a global HTTPS load balancer
- the Temporal workers on GKE Autopilot (`gke_workers`), or else as a Cloud Run worker pool
- a private Cloud SQL PostgreSQL instance
- private GCS artifact storage
- Artifact Registry and Secret Manager
- GitHub Actions authentication through Workload Identity Federation

Terraform owns everything, including each release: the image digest, public origins and non-secret runtime settings are Terraform inputs. GitHub Actions builds the image and applies the plan.

## Layout

```text
infra/
├── terraform/
│   ├── environments/{dev,prod}/
│   └── modules/selfbench-environment/
├── runtime/
│   └── *.env.example
├── ci/{verify-source,new-migrations}.sh
└── check.sh
```

## Prerequisites

- Terraform 1.14.2
- Google Cloud CLI
- `jq`
- a GCP project with billing enabled
- a private, versioned GCS bucket for Terraform state

Project creation, billing attachment, GitHub environment protection, and the initial Workload Identity Federation setup are organization-level bootstrap operations. Configure them once through your normal cloud administration process; they are intentionally not implemented as a second provisioning framework in this repository.

## Validate Locally

Validation does not use cloud credentials:

```sh
bash infra/check.sh
```

This checks shell syntax, formats and validates Terraform, and runs the module's native Terraform tests.

## Plan and Apply Manually

Copy the examples without committing the resulting files:

```sh
cd infra/terraform/environments/dev
cp backend.hcl.example backend.hcl
cp terraform.tfvars.example terraform.tfvars
```

Set `image`, `public_url`, `results_site_url` and the other runtime inputs, then initialize, review a saved plan, and apply that exact plan:

```sh
terraform init -backend-config=backend.hcl -input=false
terraform validate
terraform plan -out=dev.tfplan
terraform show -no-color dev.tfplan
terraform apply dev.tfplan
```

Use the independent `prod` root, project, state bucket, and variables for production. Terraform state and saved plans may contain sensitive infrastructure data; do not publish them as public CI artifacts.

## Runtime Configuration

Terraform creates one Secret Manager container for each sensitive runtime value. Existing environments migrated from env-file bundles set `import_runtime_secrets` to adopt containers created before that release. Values are loaded out of band so they never enter Terraform state:

```sh
printf '%s' "$VALUE" | gcloud secrets versions add selfbench-session-secret --project PROJECT --data-file=-
```

Required secrets:

- `selfbench-database-url`
- `selfbench-eval-credential-key`
- `selfbench-sandbox-secret`
- `selfbench-temporal-api-key`
- `selfbench-github-oauth-client-secret`
- `selfbench-session-secret`
- `selfbench-api-token`
- `selfbench-worker-api-token`

Optional secrets must have a version before their feature is enabled:

- `selfbench-managed-openrouter-api-key`, `selfbench-managed-e2b-api-key`, `selfbench-managed-modal-token-id` and `selfbench-managed-modal-token-secret` when `managed_offering` is true
- `selfbench-stripe-secret-key` and `selfbench-stripe-webhook-secret` when `managed_offering` is true and `stripe_price_id` is set

`selfbench-task-canary` is retired: nothing reads it, and Terraform keeps its container only because secrets are never destroyed.

`managed_offering` is the one switch for the managed offering (`SELFBENCH_MANAGED_OFFERING` in the app). It defaults to false: the deployment is bring-your-own-key only, reads none of the secrets above, ignores `stripe_price_id`, and the app has no Billing page.

Cloud Run and GKE read `latest` when new instances start. Add a secret version, then deploy; the deploy labels new Cloud Run revisions with its run ID, so every release starts instances with the latest values. Running instances keep the values they started with until they are replaced.

Non-secret runtime settings live in `TF_INPUTS_JSON` or are derived by Terraform. See `infra/runtime/*.env.example` for the full split. Images are deployed by immutable Artifact Registry digest.

The runtime expects:

- a TLS PostgreSQL URL
- separate Temporal namespaces for dev and prod
- separate GitHub OAuth applications
- a configured public HTTPS origin, listed with the results site's host in `api_domains`

## GitHub Deployment

The repository includes:

- `.github/workflows/deploy-dev.yml` for `main`
- `.github/workflows/deploy-prod.yml` for stable GitHub releases
- `.github/workflows/deploy-reusable.yml` for the shared build, plan, and apply steps

Configure `dev` and `prod` GitHub environments. Production should require reviewers and allow only release tags. Each environment needs these variables:

| Variable | Purpose |
| --- | --- |
| `GCP_DEPLOY_ENABLED` | Set to `true` to enable deployment |
| `GCP_PROJECT_ID` | Target GCP project |
| `GCP_PLAN_WORKLOAD_IDENTITY_PROVIDER` | Planner WIF provider |
| `GCP_PLAN_SERVICE_ACCOUNT` | Planner service account |
| `GCP_APPLY_WORKLOAD_IDENTITY_PROVIDER` | Apply/deploy WIF provider |
| `GCP_APPLY_SERVICE_ACCOUNT` | Apply/deploy service account |
| `TF_STATE_BUCKET` | Environment Terraform state bucket |
| `TF_INPUTS_JSON` | JSON object matching the root Terraform variables |
| `SELFBENCH_PUBLIC_URL` | Public HTTPS origin |
| `SELFBENCH_RESULTS_SITE_URL` | Results site HTTPS origin, checked after each deploy. Its host becomes `results_site_domain`: that host is served through Cloud CDN, and its cache is cleared after each apply |
| `SELFBENCH_ACTIVITY_CONCURRENCY` | Worker concurrency from 1 to 100 |

The workflow:

1. validates the repository and application;
2. verifies the source event before cloud authentication;
3. builds and pushes a digest-pinned image (on dev, alongside step 1 rather than after it);
4. creates a saved Terraform plan with the planner identity, with that digest, the public origins, run ID and activity concurrency as inputs;
5. creates a Cloud SQL backup: before every prod release, and before a dev release only when it brings migrations the dev database has not run (`infra/ci/new-migrations.sh`), since Cloud SQL's daily backups and point-in-time recovery cover the rest;
6. applies that same local plan with the apply identity. The new API revision migrates the database as it starts, then the worker pool rolls;
7. checks the public API and results site.

GitHub environment protection is the approval boundary. Terraform provides state locking. Dev accepts the default branch (push or manual dispatch); prod accepts only a published, non-draft, non-prerelease release whose commit is on the default branch. `infra/ci/verify-source.sh` checks this before cloud authentication. The planner and apply identities are separate service accounts reached through OIDC/WIF, never service-account keys. The saved plan stays on the ephemeral runner and is applied by path; a retried job plans again.

## Cloud Run

The API is a Cloud Run service reachable only through the load balancer, with its own service account. It can scale out: nothing about a request or a Codex sign-in lives in process memory. It reads the client IP from the address the load balancer appends to `X-Forwarded-For`. Without `gke_workers`, the worker is a worker pool of `worker_instances` instances under the runtime service account, polling both queues. Both reach private Cloud SQL through the VPC.

Before the first release to a new environment:

1. Grant the plan and apply roles the permissions for Cloud Run services and worker pools (`run.services.*`, `run.workerPools.*`, `run.operations.get`, and `iam.serviceAccounts.actAs` on the API and runtime accounts), the global load balancer (`compute.globalAddresses`, `compute.regionNetworkEndpointGroups`, `compute.backendServices`, `compute.urlMaps` including `compute.urlMaps.invalidateCache` for the apply role, which clears the results site's CDN after each release, `compute.targetHttpProxies`, `compute.targetHttpsProxies`, `compute.globalForwardingRules`, and their operations), Certificate Manager (`certificatemanager.dnsauthorizations`, `certs`, `certmaps`, `certmapentries`, and `operations`), `artifactregistry.repositories.downloadArtifacts` (Cloud Run checks that the deploying account can read the image), and service account creation. The plan role only needs the `get` and `list` permissions. A Terraform plan names any permission that is still missing.
2. Put `"api_domains": ["app.example", "example"]` and, if needed, `"redirect_domains": {"www.example": "example"}` in `TF_INPUTS_JSON`, and release.
3. Add each CNAME under `deployment.api.dns_authorizations`, and point each domain's A record at `deployment.api.address`. The certificate becomes active a few minutes after the CNAMEs resolve (`gcloud certificate-manager certificates describe selfbench-<env>-api`), and the load balancer answers HTTPS a few minutes after that.

## GKE Workers

With `"gke_workers": true`, every Temporal worker runs on a GKE Autopilot cluster in the app VPC, from `modules/selfbench-environment/charts/selfbench-workers`, and Cloud Run runs only the API. The workflow worker is a Deployment of `worker_instances` pods; a restart loses no work, since workflows replay and sandbox activities complete through the callback API. Harbor work (the `<task queue>-harbor` queue: Harbor checks and solver trials) runs as jobs: KEDA starts a job pod per 10 waiting tasks, up to `harbor_worker_max_replicas` at once; each runs up to 10 and exits after 5 idle minutes (or stops taking work after a day), so no busy pod is ever removed. Autopilot caps termination grace at 10 minutes, which is why these are jobs rather than a Deployment. Worker pods keep to nodes of their own (Autopilot workload separation), where GKE's system Deployments cannot preempt them; billing stays per pod request. Harbor nodes run as their own `selfbench-<env>-gke-nodes` account (image pulls, logs, metrics); the apply role also needs `iam.serviceAccounts.actAs` on it.

To turn it on:

1. Grant the apply role `roles/container.admin`, and the plan role `container.clusters.get` plus read access to Secrets in the `keda` and `selfbench` namespaces, where Helm keeps its release records. Both also need `compute.instanceGroupManagers.get` and `.list`: the provider reads the cluster's node pools through them.
2. Add the Temporal API key as a version of `selfbench-temporal-api-key`.
3. Add `"gke_workers": true`, `"temporal_address"` and `"temporal_namespace"` to `TF_INPUTS_JSON`, and release.

## Task Images

With `"task_images": true`, the worker exports each accepted task's verified images, the Modal images its oracle passed on, into the `selfbench-tasks` Artifact Registry repository, and E2B and Docker trials start from them by digest instead of building the task's Dockerfiles. Only accepted tasks are exported, once each. The runtime account writes the repository and the API account reads it. Sandbox providers never get a credential for the repository: they pull through the API's `/v2/` registry endpoint with a grant for one task's images, and image layers are redirected to Artifact Registry's own download URLs.

To turn it on:

1. Grant the apply role `artifactregistry.repositories.create` (already needed for `selfbench`) and `artifactregistry.repositories.setIamPolicy`.
2. Add `"task_images": true` to `TF_INPUTS_JSON`, and release.

## Operational Notes

- Dev and prod must not share projects, buckets, databases, Temporal namespaces, OAuth apps, or secrets.
- The API and the worker run under separate service accounts and read only the secret values they need.
- Roll back an image only when database migrations and Temporal workflow replay remain compatible.
- Keep previous image digests and secret versions. Disable old secret versions only after the instances using them have been replaced. Never auto-roll back a database migration.
