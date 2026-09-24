# SelfBench Infrastructure

SelfBench runs on a small GCP stack managed with Terraform:

- one isolated project per environment
- the API on Cloud Run behind a global HTTPS load balancer
- the Temporal worker as a Cloud Run worker pool
- a private Cloud SQL PostgreSQL instance
- private GCS artifact storage
- Artifact Registry and Secret Manager
- GitHub Actions authentication through Workload Identity Federation

Terraform owns everything, including each release: the image digest and pinned secret versions are Terraform inputs. GitHub Actions builds the image and applies the plan.

## Layout

```text
infra/
├── terraform/
│   ├── environments/{dev,prod}/
│   └── modules/selfbench-environment/
├── runtime/
│   ├── secret-versions/{dev,prod}.json
│   └── *.env.example
├── ci/verify-source.sh
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

Set `image` to a pushed digest and `secret_versions` to the manifest's versions, then initialize, review a saved plan, and apply that exact plan:

```sh
terraform init -backend-config=backend.hcl -input=false
terraform validate
terraform plan -out=dev.tfplan
terraform show -no-color dev.tfplan
terraform apply dev.tfplan
```

Use the independent `prod` root, project, state bucket, and variables for production. Terraform state and saved plans may contain sensitive infrastructure data; do not publish them as public CI artifacts.

## Runtime Configuration

Create these Secret Manager secrets in each environment:

- `selfbench-shared-env`
- `selfbench-api-env`
- `selfbench-worker-env`

Use the files under `infra/runtime/*.env.example` as the key layout. Store actual values only in Secret Manager. Cloud Run mounts each pinned version as a file that Node loads with `--env-file`: the API reads the shared and API bundles, and the worker reads the shared and worker bundles. Record the numeric version of each secret in:

```text
infra/runtime/secret-versions/dev.json
infra/runtime/secret-versions/prod.json
```

Deployments never use `latest`. Images are deployed by immutable Artifact Registry digest.

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
| `SELFBENCH_RESULTS_SITE_URL` | Results site HTTPS origin, checked after each deploy |
| `SELFBENCH_ACTIVITY_CONCURRENCY` | Worker concurrency from 1 to 100 |

The workflow:

1. validates the repository and application;
2. verifies the source event before cloud authentication;
3. builds and pushes a digest-pinned image;
4. creates a saved Terraform plan with the planner identity, with that digest, the pinned secret versions and the activity concurrency as inputs;
5. creates a Cloud SQL backup;
6. applies that same local plan with the apply identity. The new API revision migrates the database as it starts, then the worker pool rolls;
7. checks the public API and results site.

GitHub environment protection is the approval boundary. Terraform provides state locking. The workflow does not maintain a custom plan-manifest service or a separate private plan bucket.

## Cloud Run

The API is a Cloud Run service reachable only through the load balancer, with its own service account. It can scale out: nothing about a request or a Codex sign-in lives in process memory. It reads the client IP from the address the load balancer appends to `X-Forwarded-For`. The worker is a worker pool of `worker_instances` instances under the runtime service account. Both reach private Cloud SQL through the VPC.

Before the first release to a new environment:

1. Grant the plan and apply roles the permissions for Cloud Run services and worker pools (`run.services.*`, `run.workerPools.*`, `run.operations.get`, and `iam.serviceAccounts.actAs` on the API and runtime accounts), the global load balancer (`compute.globalAddresses`, `compute.regionNetworkEndpointGroups`, `compute.backendServices`, `compute.urlMaps`, `compute.targetHttpProxies`, `compute.targetHttpsProxies`, `compute.globalForwardingRules`, and their operations), Certificate Manager (`certificatemanager.dnsauthorizations`, `certs`, `certmaps`, `certmapentries`, and `operations`), `artifactregistry.repositories.downloadArtifacts` (Cloud Run checks that the deploying account can read the image), and service account creation. The plan role only needs the `get` and `list` permissions. A Terraform plan names any permission that is still missing.
2. Put `"api_domains": ["app.example", "example"]` and, if needed, `"redirect_domains": {"www.example": "example"}` in `TF_INPUTS_JSON`, and release.
3. Add each CNAME under `deployment.api.dns_authorizations`, and point each domain's A record at `deployment.api.address`. The certificate becomes active a few minutes after the CNAMEs resolve (`gcloud certificate-manager certificates describe selfbench-<env>-api`), and the load balancer answers HTTPS a few minutes after that.

## Operational Notes

- Dev and prod must not share projects, buckets, databases, Temporal namespaces, OAuth apps, or secrets.
- The API and the worker run under separate service accounts and read only their own secrets.
- Roll back an image only when database migrations and Temporal workflow replay remain compatible.
- Keep previous image digests and secret versions. Never auto-roll back a database migration.
