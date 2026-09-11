# SelfBench on GCP: Dev and Prod

**Status: reviewable infrastructure code, not a live deployment.** Nothing here creates resources
unless an operator explicitly runs bootstrap with `--execute` or applies an approved Terraform plan.
All names in `*.example` are placeholders. Do not copy production secrets into dev.

## Architecture

```text
                            Build once, promote the SAME image digest
                                         |
                    +--------------------+--------------------+
                    |                                         |
          selfbench-dev-<suffix>                   selfbench-prod-<suffix>
          Separate project/state                   Separate project/state
                    |                                         |
          VM: API + combined worker                VM: API + combined worker
          GCS: dev artifacts                       GCS: prod artifacts
          SQL: private, zonal                       SQL: private, zonal pilot
          Secret Manager: dev                      Secret Manager: prod
                    |                                         |
          Temporal: selfbench-dev.<account>         Temporal: selfbench-prod.<account>
          Queue: selfbench-dev                     Queue: selfbench-prod
                    |                                         |
          Dev sandbox credentials                  Prod sandbox credentials
                    +--------- Modal / E2B / Daytona ----------+
```

The initial generation configuration is **Modal + Modal Harbor**, with concurrency one.
Hosted solver choices use selected saved credentials. The Dockerfile includes the pinned Harbor
extras for Modal, E2B and Daytona. Switching generation to E2B requires a prepared template and a
reviewed extension to the runtime preflight contract; it is not an implicit fallback.

There is **one combined worker** per environment. `SELFBENCH_EVAL_TASK_QUEUE` equals
`SELFBENCH_TASK_QUEUE`; a separate queue without a dedicated worker would strand evaluation jobs.
Temporal Cloud namespaces must be separate; queues alone are not an access boundary.

### Proposed defaults (review before spending)

| Resource | Dev | Prod |
| --- | --- | --- |
| Region / zone | `us-central1` / `us-central1-a` | Same proposal |
| Coordinator VM | `e2-standard-2`, 50 GB balanced boot disk | Same starting size |
| Postgres 17 | Cloud SQL, zonal `db-f1-micro` | Cloud SQL, zonal pilot `db-custom-1-3840` |
| SQL backups | PITR, 7 retained backups | PITR, 14 retained backups |
| Artifact bucket | Private, versioned, no destructive cleanup | Same |
| Public ingress | Disabled | Disabled |
| SSH | IAP-only with OS Login | Same |
| App availability | Single VM | Single VM, **not an HA application** |

These are proposals, not measured capacity requirements or cost estimates. Regional Cloud SQL HA is
intentionally not enabled by the pilot defaults; opt into it explicitly after reviewing cost and
availability needs. Cloud SQL, VMs,
external IPs, storage versions, flow logs and sandbox/model usage incur separate charges. Set project
budgets/alerts and sandbox spending controls before provisioning. Budget alerts are not spending caps.
Set `create_cloud_sql=false` only when a separate managed database is already selected.

The VM runtime service account can read its own three secret bundles and its own registry; it can
manage objects in its artifact bucket and sign blobs using its own identity (required for short-lived
GCS verifier download URLs). It has no project-wide Editor/Owner or cross-project grants.
API/worker env-files are separated, **but they share one host/service account**. This is not strong
API-versus-worker IAM isolation. Use separate hosts/identities if that is required. Repository code
runs on hosted sandboxes; neither application container mounts a Docker socket.

## What This Pass Includes

- One reusable Terraform module; separate `dev` and `prod` roots, lockfiles and GCS backends.
- Isolated network, IAP firewall, VM, service account, registry, artifacts and secret containers.
- Optional private Cloud SQL instance/database. **No database password or user is created.**
- Dry-run-first bootstrap CLI, standalone cloud Compose configuration and release preflight.
- Mock-only Terraform tests, Python/Compose tests and credential-free infrastructure CI.

Still required before live service: account/parent/billing selection; actual projects and state
buckets; Temporal namespaces and scoped API keys; OAuth apps/domains; SQL login provisioning;
secret payloads; TLS proxy installation; authenticated image publishing/promotion; live migration,
recovery and end-to-end tests. Keyless GitHub authentication is a separate opt-in bootstrap described in
[`github-auth.md`](github-auth.md). Its manual smoke workflow does not grant planning/apply permissions.
The validation workflow cannot deploy or obtain cloud credentials; automatic deployment remains unwired.

## 1. Confirm the Target Account and Bootstrap

Use `gcloud auth list`, `gcloud billing accounts list`, and organization/folder discovery read-only
first. Choose the exact account, billing account, parent, and globally unique project IDs. Do not
change the global gcloud project or account: scripts pass them explicitly.

This command **prints a plan without invoking gcloud at all**:

```sh
python3 infra/bootstrap/bootstrap.py \
  --environment dev --project selfbench-dev-YOUR-SUFFIX \
  --account YOUR-GCP-EMAIL --billing-account YOUR-BILLING-ID \
  --folder YOUR-FOLDER-ID --region us-central1 \
  --state-bucket selfbench-dev-YOUR-SUFFIX-tfstate
```

Replace every placeholder. For a top-level parent use `--organization ID`; for an explicitly
unparented project use `--no-organization`. Review, then add **`--execute`** only after approval.
Repeat with independent prod values. The CLI checks project labels/parent, refuses billing relinks,
and verifies bucket ownership, location, access prevention and versioning. Matching partial bootstrap
state can resume. It never deletes a project to recover from an error; inspect partial state first.
Bootstrap creates only project/billing/API/state-bucket resources, not VMs or databases.

Keep backend IAM limited to the environment's infrastructure operators. The app runtime has **no
state-bucket grant**. GCS provides Terraform state locking; enable versioning for recovery. The
bootstrap project/state buckets are intentionally outside the environment Terraform root's lifecycle.

## 2. Validate Without Cloud Access

Required local versions: **Terraform 1.14.2**, locked `hashicorp/google` **7.46.1**, Python 3.10+,
and Docker Compose 2.30+ (`env_file.format: raw`). Bootstrap flags were checked against installed
Google Cloud SDK 569.0.0. The host startup script follows Docker's Debian repository installation;
OS package versions are not pinned, so a VM rebuild still requires validation.

```sh
bash infra/check.sh
```

This downloads providers, runs `fmt -check`, initializes with the backend **disabled**, validates both
roots, and runs mocked provider plans. Python tests stub gcloud; Docker only parses Compose fixtures.
No real Terraform plan, apply, database connection, sandbox run or image build is performed.
A passing mocked test is **not** proof of permissions, quota, account policy, cost, or live readiness.

The committed provider lockfiles include package checksums for both `darwin_arm64` (local development)
and `linux_amd64` (GitHub Actions). After changing provider pins, run the following in each initialized
Terraform root, including the shared module, and commit the resulting lockfiles:

```sh
terraform providers lock -platform=darwin_arm64 -platform=linux_amd64
```

Add other platforms explicitly when needed. Keep `-lockfile=readonly` in CI; do not bypass checksum
verification to fix a missing platform checksum.

## 3. Review a Real Dev Plan

After approved bootstrap, copy `backend.hcl.example` and `terraform.tfvars.example` in the dev root
to `backend.hcl` and `terraform.tfvars` (both ignored). Use the dedicated dev bucket/project and
explicit `operator_members` (OS Admin Login, runtime act-as, and instance-scoped IAP tunneling).
Keep prod operators narrower than dev; no automatic CI deployment identity is granted. Select a
real, versioned Debian image with a read-only command, for example:

```sh
gcloud compute images list --project=debian-cloud --account=YOUR-GCP-EMAIL \
  --filter='family=debian-12 AND status=READY' --format='table(name,creationTimestamp)'
```

Use `projects/debian-cloud/global/images/EXACT-NAME`; image families are rejected. Authenticate
Terraform using the chosen operator's ADC or a separately approved impersonation path. Never commit
service-account keys. Then, from the dev root:

```sh
terraform init -backend-config=backend.hcl -input=false
terraform validate
terraform plan -out=dev.tfplan
terraform show -no-color dev.tfplan
# ONLY AFTER reviewing target project, cost, IAM, replacements and resources:
terraform apply dev.tfplan
```

Use separate `prod.tfplan` and prod root/backend for production. Saved plans/state contain sensitive
infrastructure information: do not publish them as public CI artifacts. Never use `-auto-approve`,
`-target` or force-unlock as routine deployment tools. IAM/API propagation and organization policies
remain live-plan/apply risks. Review whether public VM IPs are permitted in your organization.

## 4. Prepare a Dev Release (Separate From Terraform)

1. Terraform startup installs Docker/Compose only. It does **not** start an app or open a default page.
2. Provision an appropriately scoped Postgres login through an approved database administration path;
   store the TLS connection URL outside Terraform. New-instance authentication is a required bootstrap
   step, not something the runtime service account magically receives. Validate connectivity from the
   VM. Review CA verification requirements; the starter URL requires encryption (`sslmode=require`).
3. Create dev Temporal/OAuth configuration. OAuth callback is the dev HTTPS origin plus
   `/auth/github/callback`. Establish a separate prod namespace and OAuth app later.
4. Populate Secret Manager `selfbench-shared-env`, `selfbench-api-env`, `selfbench-worker-env`
   using the role-specific examples. Secret values never go through Terraform or VM metadata.
   Use a secure operator workflow such as `gcloud secrets versions add ... --data-file=...`; never
   put literal payloads in shell history. Record exact secret version numbers with the release.
5. Retrieve **specific numeric secret versions**, not `latest`, to protected files on the VM.
   Operator retrieval can use `gcloud secrets versions access VERSION --secret=NAME --project=PROJECT
   --out-file=FILE` under `umask 077`. Transfer/install securely if retrieving off-host. Files must be
   owned by the deployment user with mode `0600` in a restricted directory. Never run `source` on them.
   Protect/clean any temporary copies. Production's encryption key must be backed up separately.
6. Build/test the app on CI, publish an immutable digest to the dev registry, and prepare the nonsecret
   `release.env`. Use the full commit SHA as an immutable tag. CI needs a separately reviewed scoped
   publisher identity; the runtime account is deliberately read-only. Cloud VMs are x86, so an ARM
   workstation build must explicitly target `linux/amd64`. No published image is supplied by this change.
7. Install/validate Caddy on the host using `runtime/Caddyfile.example`, configure DNS, and open web
   ingress only through a separately reviewed `enable_public_web=true` change. DNS ownership and TLS
   issuance are not proven by Terraform. No public route to API port 8080, Postgres or Temporal.

Preflight on the VM (local reads only, never prints secrets):

```sh
python3 /opt/selfbench/releases/RELEASE/infra/runtime/check_release.py \
  --environment dev --project selfbench-dev-YOUR-SUFFIX \
  --release-env /opt/selfbench/releases/RELEASE/release.env
```

The strict initial contract catches wrong project images, mutable tags, orphaned queues, wrong
namespaces/buckets, missing TLS, leaked cross-role keys, placeholders and unsafe file permissions.
It does **not** prove that credentials work or that a database URL belongs to the right environment.
Record and independently verify those identities before deployment. Unknown env keys fail closed;
extend the reviewed contract when adding another generation backend or feature.

Authenticate Docker to only the target registry using an approved short-lived identity/credential
helper. Then, **after suspending new submissions and verifying there are no incompatible in-flight
workflows**, use the standalone runtime (not the development Compose file):

```sh
docker compose --env-file /ABSOLUTE/release.env -f /ABSOLUTE/infra/runtime/compose.yaml pull
docker compose --env-file /ABSOLUTE/release.env -f /ABSOLUTE/infra/runtime/compose.yaml up -d --wait
```

Do not print `docker compose config` with real secrets: it expands env-files. API startup precedes
worker startup to reduce concurrent migration risk, but this is not a substitute for a migration
rehearsal or coordination with older containers. Startup runs migrations; there is no automatic down
migration. The worker also opens the database. Drain/compatibility checks are an operator gate, not
implemented by Compose or by the local preflight. Upgrades may interrupt the single API VM.

## 5. Promotion and Verification Gates

- Validate the image and schema in dev; record the digest, source SHA, secret version numbers,
  Terraform plan, database backup and migration result.
- Copy/promote the **same manifest digest** into prod's registry using the approved publisher identity.
  Rebuilding from the same Git commit is not promotion. Verify source and destination digests match.
- Review/apply prod's plan independently, then deploy with prod-only env-files and secrets.
- Check API health plus anonymous rejection, actual OAuth callback, database identity/migrations,
  GCS reads/writes, actual Temporal namespace/task-queue pollers, and secret separation.
- API health alone does not prove worker health. Check Temporal poller registration and one explicitly
  budgeted live generation/evaluation run, including final artifacts and remote sandbox cleanup.
- Reboot/restart test; restore a backup into an isolated recovery environment; prove artifact and
  encrypted-credential readability. Test isolation: dev identities cannot access prod state/data.

Prod normally starts fresh. If importing local data, preserve source DB/artifacts/keys together and
rehearse in a **restricted recovery environment**, not everyday dev. The current GCS reader cannot
read local/file artifact references, so blindly copying files is insufficient; a reference-aware
migration is separate work. Do not rotate the evaluation-encryption key without re-encryption.

## Rollback and Deliberate Limits

Rollback the app to the prior digest **only if schema and Temporal replay remain compatible**.
Retain old images, release files and secret versions; never auto-rollback a database migration.
Cloud SQL, artifact/registry/secret resources and VM have `prevent_destroy` guards. Cloud SQL has
provider and API deletion protection; prod VM also has API deletion protection. Removing guards or
changing protected resources is a reviewed maintenance operation, not routine `terraform destroy`.
Do not delete state to make a failed apply pass. Capture the plan/state backup and reconcile actual
resources before retrying. GCS versions/PITR are not a substitute for a tested restoration procedure.

Follow-up work: scoped planning/state permissions and separate approved publisher/deployer identities, automatic
promotion, host/worker monitoring, alert routing, scheduled patching, retention/cost policies,
stronger host identity separation if needed, and a fully exercised disaster-recovery runbook.
