# Unified Deployment: Dari Mono Pattern

**Implementation status:** deployment code is a local draft, not live-verified. Configure and audit
your deployment identities and runtime prerequisites before enabling deployment. The opt-in defaults
to disabled for unconfigured repositories.

- `deploy-dev.yml`: main push or manual main run.
- `deploy-prod.yml`: published, non-draft, non-prerelease release.
- `deploy-reusable.yml`: app validation, source verification, private Terraform plan, approval,
  apply if changed, image build/publish, Cloud SQL backup, VM migrations/rollout and verification.
- Credential-free PR checks remain in `infra.yml` and normal app CI.

Production checks the actual release event, immutable triggering SHA and tag ancestry from main
before cloud authentication. There are exactly two deployment environments: `dev` and `prod`.
Dev deploys from main without a separate environment approval. Production retains required review;
both its plan and deployment jobs reference `prod`, so GitHub may request approval for both jobs.
Plan/apply remain pipeline jobs and cloud identities, not additional GitHub environments.

## Prerequisites and Transition

1. Review the new WIF conditions and apply-role additions in the bootstrap code. Dev trusts its
   default-branch deploy caller; prod trusts release tags and the exact reusable workflow claim.
   Existing providers/roles intentionally fail on differing policies rather than overwrite them.
   An operator must review and update these existing objects explicitly.
2. Configure the `prod` GitHub environment branch rules to allow release tags; retain required apply review.
   The source ancestry check is mandatory because tag policy alone does not establish trusted code.
3. Configure `RUNTIME_SECRET_VERSIONS` (JSON shared/api/worker numeric versions) and
   `SELFBENCH_PUBLIC_URL` in `dev` and `prod`. Populate secrets, DB login, Temporal namespace,
   provider credentials, GitHub OAuth and a host TLS proxy. Bootstrap creates empty secret containers,
   not these values. The current runtime preflight supports the documented Modal generation pairing.
4. Review DNS/TLS and set `enable_public_web=true` in the environment inputs when ready. Deployment
   refuses to claim success without reachable HTTPS health and anonymous-session rejection.
5. Set `GCP_DEPLOY_ENABLED=true` only after these prerequisites, then merge the reviewed workflow.
   This is a new flag; the old Terraform/auth flags cannot enable the unified deployment accidentally.

## Rollout Behavior

Build and publish a source-SHA/run-tagged image, resolve its digest, create a synchronous Cloud SQL
backup, transfer only code/nonsecret release coordinates through IAP, and retrieve exact secret
versions on the VM using its identity. Secret payloads are not placed in GitHub logs or artifacts.
The release files and logs are root-owned and retained on the VM for explicit recovery.

Stop the API, reject deployment if the dedicated Temporal namespace has running workflows, then
stop the old worker and run the maintained database migration code from the new image. Start API
and worker, verify local API health and recent workflow/activity pollers, then verify public HTTPS.
If quiescence fails, restart the existing API. Do not cancel jobs or automatically roll back schema
changes. The single-VM rollout entails downtime; external producers must not submit directly to the
namespace during maintenance. Poller recency is a smoke check, not full solver E2E proof.

Cloud SQL backup is required; external databases need an explicit backup adapter. Runtime secrets,
OAuth and DNS are one-time operator prerequisites, not generated placeholders. Credentials remain
outside Terraform state. This pipeline builds from the released source; it is not a cross-environment
image-promotion mechanism and does not claim dev/prod byte-identical builds.

## Review and Recovery

Private saved plans bind source SHA, run/attempt, input and provider-lock hashes, object generations
and checksums; they expire after 24 hours. Destructive/replacement plans fail closed. A no-op
infrastructure plan still runs the application deployment. Plan and deployment logs stay in private
GCS/VM storage. Terraform applies are serialized and never cancelled by a new push.

After apply failure, reconcile actual cloud state before retrying. After migration failure, inspect
the private VM log and restore service only using a schema-compatible release. Never automatically
run `terraform destroy`, roll back a database migration, or clear state locks. Disable the deployment
flag and cancel queued jobs to halt future releases; revoke exact WIF trust if necessary.

Local tests and workflow linting do not prove live rollout. Full image build, WIF exchange for the
new callers, actual permissions, DB backup/restore, migrations, worker and HTTPS checks still need a
controlled dev deployment. **No live deployment was run while implementing this draft.**

## Environment Settings

Each environment holds common project/state/runtime settings plus two named identity pairs:
`GCP_PLAN_SERVICE_ACCOUNT`, `GCP_PLAN_WORKLOAD_IDENTITY_PROVIDER`,
`GCP_APPLY_SERVICE_ACCOUNT`, `GCP_APPLY_WORKLOAD_IDENTITY_PROVIDER`.
These preserve different cloud permissions without duplicating deployment environments.
The original `GCP_SERVICE_ACCOUNT` and `GCP_WORKLOAD_IDENTITY_PROVIDER` remain for the manual
non-provisioning auth check. Production now permits release tags, so its old main-only auth check
is intentionally not a release test; use the production deployment workflow's authenticated jobs.
Unrelated package-publishing environments must not be removed during consolidation.

## First Dev Deployment (Infrastructure Before Secrets)

The explicit manual `Deploy Dev` input `infrastructure_only=true` runs the same validation,
private plan and Terraform apply stages, but skips runtime secret validation and application rollout.
This creates **billed** dev infrastructure and empty secret containers. It does not invent credentials
or report the application as deployed. It is prohibited for main-push and production events; the mode
is bound into the saved-plan receipt.

After merging and enabling the opt-in, choose this input only when ready to provision dev. Then
configure the database login, exact Secret Manager versions, Temporal, OAuth, DNS/TLS and ingress.
Run `Deploy Dev` again with the default `infrastructure_only=false` to deploy the app. Normal main
pushes and stable production releases always use the full deployment path.
