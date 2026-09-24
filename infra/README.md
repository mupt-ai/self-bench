# SelfBench Infrastructure

SelfBench runs on a small GCP stack managed with Terraform:

- one isolated project per environment
- one Compute Engine VM running the worker (and, until cutover, the API) with Docker Compose
- optionally, the API on Cloud Run behind a global HTTPS load balancer
- a private Cloud SQL PostgreSQL instance
- private GCS artifact storage
- Artifact Registry and Secret Manager
- GitHub Actions authentication through Workload Identity Federation

Terraform owns cloud resources. GitHub Actions builds and deploys the application. The host deployment script only fetches pinned secret versions and starts the digest-pinned Compose release.

## Layout

```text
infra/
├── terraform/
│   ├── environments/{dev,prod}/
│   └── modules/selfbench-environment/
├── runtime/
│   ├── compose.yaml
│   ├── deploy-host.sh
│   └── *.env.example
├── ci/verify-source.sh
└── check.sh
```

## Prerequisites

- Terraform 1.14.2
- Google Cloud CLI
- Docker Compose 2.30 or newer
- `jq`
- a GCP project with billing enabled
- a private, versioned GCS bucket for Terraform state

Project creation, billing attachment, GitHub environment protection, and the initial Workload Identity Federation setup are organization-level bootstrap operations. Configure them once through your normal cloud administration process; they are intentionally not implemented as a second provisioning framework in this repository.

## Validate Locally

Validation does not use cloud credentials:

```sh
bash infra/check.sh
```

This checks shell syntax and Compose configuration, formats and validates Terraform, and runs the module's native Terraform tests.

## Plan and Apply Manually

Copy the examples without committing the resulting files:

```sh
cd infra/terraform/environments/dev
cp backend.hcl.example backend.hcl
cp terraform.tfvars.example terraform.tfvars
```

Select an exact Debian image rather than an image family:

```sh
gcloud compute images list \
  --project=debian-cloud \
  --filter='family=debian-12 AND status=READY' \
  --format='table(name,creationTimestamp)'
```

Then initialize, review a saved plan, and apply that exact plan:

```sh
terraform init -backend-config=backend.hcl -input=false
terraform validate
terraform plan -out=dev.tfplan
terraform show -no-color dev.tfplan
terraform apply dev.tfplan
```

Use the independent `prod` root, project, state bucket, and variables for production. Terraform state and saved plans may contain sensitive infrastructure data; do not publish them as public CI artifacts.

## Runtime Configuration

The VM startup script installs Docker Compose, `curl`, and `jq`. It does not fetch secrets or start SelfBench.

Create these Secret Manager secrets in each environment:

- `selfbench-shared-env`
- `selfbench-api-env`
- `selfbench-worker-env`

Use the files under `infra/runtime/*.env.example` as the key layout. Store actual values only in Secret Manager. Record the numeric version of each secret in:

```text
infra/runtime/secret-versions/dev.json
infra/runtime/secret-versions/prod.json
```

Deployments never use `latest`. Images are deployed by immutable Artifact Registry digest.

The runtime expects:

- a TLS PostgreSQL URL
- separate Temporal namespaces for dev and prod
- separate GitHub OAuth applications
- a configured public HTTPS origin
- Caddy or another host TLS proxy forwarding to `127.0.0.1:8080`, for the app's host and the
  results site's host alike (`infra/runtime/Caddyfile.example`)

Public web ingress is disabled by default. Enable it only after DNS and TLS are configured.

## GitHub Deployment

The repository includes:

- `.github/workflows/deploy-dev.yml` for `main`
- `.github/workflows/deploy-prod.yml` for stable GitHub releases
- `.github/workflows/deploy-reusable.yml` for the shared plan, apply, build, and rollout steps

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
3. creates a saved Terraform plan with the planner identity;
4. applies that same local plan with the apply identity;
5. builds and pushes a digest-pinned image;
6. creates a Cloud SQL backup;
7. sends the Compose bundle and release request to the VM over IAP;
8. fetches pinned secret versions, runs migrations, starts Compose, and checks API and worker health.

GitHub environment protection is the approval boundary. Terraform provides state locking. The workflow does not maintain a custom plan-manifest service or a separate private plan bucket.

## API on Cloud Run

Setting `api_domains` in `TF_INPUTS_JSON` runs the API on Cloud Run as well as the VM, so a busy or broken worker VM can't take the site down. The API gets its own service account, reads only the shared and API secrets, and reaches Cloud SQL through the VPC. It runs as exactly one always-on instance, because Codex sign-in keeps its pending login process in memory. Each release runs `gcloud run deploy` with the new image and the pinned secret versions, which are mounted as files and loaded by `dist/api/cloud-run.js`. The API reads the client IP from the second-to-last `X-Forwarded-For` entry (`SELFBENCH_FORWARDED_HOPS=2`); the service's load-balancer-only ingress prevents anyone from bypassing the load balancer to spoof it.

Cut over with no TLS gap:

1. Grant the plan and apply roles the permissions for Cloud Run (`run.services.*`, `run.operations.get`, and `iam.serviceAccounts.actAs` on the API account), the global load balancer (`compute.globalAddresses`, `compute.regionNetworkEndpointGroups`, `compute.backendServices`, `compute.urlMaps`, `compute.targetHttpProxies`, `compute.targetHttpsProxies`, `compute.globalForwardingRules`, and their operations), Certificate Manager (`certificatemanager.dnsauthorizations`, `certs`, `certmaps`, `certmapentries`, and `operations`), and service account creation. The plan role only needs the `get` and `list` permissions. A Terraform plan names any permission that is still missing.
2. Set `"api_domains": ["app.example", "example"]` and, if needed, `"redirect_domains": {"www.example": "example"}`, keep `vm_serves_api` true, and deploy. The VM and Cloud Run now both serve the API.
3. Add each CNAME under `deployment.api.dns_authorizations`, and wait until `gcloud certificate-manager certificates describe selfbench-<env>-api` reports `ACTIVE`.
4. Check the new path before switching: `curl --resolve app.example:443:<deployment.api.address> https://app.example/healthz`.
5. Point each domain's A record at `deployment.api.address`, and wait for the old records' TTL to expire.
6. Set `"vm_serves_api": false` and `"enable_public_web": false`, then deploy. The VM now runs only the worker, and its ports 80 and 443 close. Stop Caddy on the VM.

To roll back before step 6, point DNS back at the VM. After step 6, set `vm_serves_api` back to true and deploy first.

## Operational Notes

- Dev and prod must not share projects, buckets, databases, Temporal namespaces, OAuth apps, or secrets.
- The application is a single-VM deployment, not a high-availability architecture.
- API and worker env files are separated, but both containers share one VM service account.
- Do not mount the Docker socket into application containers.
- Roll back an image only when database migrations and Temporal workflow replay remain compatible.
- Keep previous image digests and secret versions. Never auto-roll back a database migration.
