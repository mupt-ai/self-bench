# Unified Deployment: Dari Mono Pattern

**Implementation status:** deployment code is a local draft, not live-verified. Configure and audit
your deployment identities and runtime prerequisites before enabling deployment. The opt-in defaults
to disabled for unconfigured repositories.

- `deploy-dev.yml`: every main push, including merges, or manual main run; no path filters.
- `deploy-prod.yml`: published, non-draft, non-prerelease release.
- `deploy-reusable.yml`: app validation, source verification, private Terraform plan, approval,
  apply if changed, image build/publish, Cloud SQL backup, VM migrations/rollout and verification.
- Credential-free PR checks remain in `infra.yml` and normal app CI.

Merging into main starts the full dev deployment, not just Terraform. Publishing a stable GitHub
release starts the full production deployment, subject to the configured production approval.
Both workflows validate, plan/apply infrastructure, build the image, back up the database, migrate,
roll out the API and worker, and verify service health. No manual SSH rollout should be needed.
Production builds the release commit; it does not promote the exact dev image digest.

Production checks the actual release event, immutable triggering SHA and tag ancestry from main
before cloud authentication. Planning and apply use the same protected `prod` environment, so
production configuration and approval have one source of truth. The plan and apply steps still use
separate least-privilege GCP identities. Approval happens once, before planning, apply, and the
application rollout, rather than between plan and apply.

## Prerequisites and Transition

1. Review the new WIF conditions and apply-role additions in the bootstrap code. Dev trusts its
   default-branch deploy caller; prod trusts release tags and the exact reusable workflow claim.
   Existing providers/roles intentionally fail on differing policies rather than overwrite them.
   An operator must review and update these existing objects explicitly.
2. Configure the `prod` GitHub environment branch rules to allow release tags; retain required apply review.
   The source ancestry check is mandatory because tag policy alone does not establish trusted code.
3. Configure `SELFBENCH_ACTIVITY_CONCURRENCY` (integer 1-100) and `SELFBENCH_PUBLIC_URL` as ordinary
   GitHub environment variables in `dev` and `prod`. Commit reviewed numeric Secret Manager version
   pins in `infra/runtime/secret-versions/{dev,prod}.json`; the deploy validation loads the manifest
   for the target environment. Populate secrets, DB login, Temporal namespace, provider credentials,
   GitHub OAuth and a host TLS proxy. Bootstrap creates empty secret containers, not these values.
   The current runtime preflight supports the documented Modal generation pairing.
4. Review DNS/TLS and set `enable_public_web=true` in the environment inputs when ready. Deployment
   refuses to claim success without reachable HTTPS health and anonymous-session rejection.
5. Set `GCP_DEPLOY_ENABLED=true` only after these prerequisites, then merge the reviewed workflow.
   This is a new flag; the old Terraform/auth flags cannot enable the unified deployment accidentally.

## Rollout Behavior

Each release stage is a named step in `deploy-reusable.yml`: verify the deploy source and runtime
settings (`infra/ci/verify-source.sh`), read nonsecret Terraform coordinates (Terraform CLI + jq),
build and push a source-SHA/run-tagged image with `docker/build-push-action` (GHA layer cache scoped
per environment; the step's digest output is the only image reference used afterwards), create a
synchronous Cloud SQL backup, then ship the reviewed `infra/runtime` bundle plus a `request.json`
through one IAP SSH session (`tar` over `gcloud compute ssh`). The VM retrieves exact secret
versions using its own identity. Secret payloads are not placed in GitHub logs or artifacts. The
release files and logs are root-owned and retained on the VM for explicit recovery.

Stop the API and gracefully stop the old worker, even when Temporal workflows are running, and run the maintained database migration code from the new image. Start API
and worker, verify local API health and recent workflow/activity pollers, then verify public HTTPS.
Do not cancel or terminate workflows or automatically roll back schema changes. Compose allows
two minutes for shutdown before forcing the container to stop; in-flight activities may be
interrupted and retry according to their retry policies. This is not zero-downtime execution. The single-VM rollout entails downtime; external producers must not submit directly to the
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
Both production phases use the `prod` GitHub environment. The plan identity is read-only and the
apply identity is privileged; this is intentionally four identity variables rather than one broad
credential shared by both phases. `GCP_PROJECT_ID`, `TF_STATE_BUCKET`, `TF_PLAN_BUCKET`,
`TF_INPUTS_JSON` and `SELFBENCH_PUBLIC_URL` are the shared deployment coordinates for that environment.
Secret version pins are reviewed in `infra/runtime/secret-versions/`, alongside the runtime bundle.
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

## User-Owned Generation Credentials

Generation uses the user-selected encrypted model and sandbox credentials from the application database. The VM worker must not be configured with global `OPENAI_API_KEY`, `SELFBENCH_PI_AUTH_JSON`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `E2B_API_KEY`, `VERCEL_TOKEN`, or `GH_TOKEN` values for generation. `generationEnvironment()` resolves the selected user credentials and the submitting user's GitHub OAuth token server-side and injects them only into that run's activities and isolated sandbox. The deploy preflight therefore requires only the worker runtime token, not provider credentials.

### Migrating Existing Releases

Existing release tags retain their original workflow and may still require `prod-plan`. Keep that
environment until those deployments finish and the cleanup is merged. During transition the plan
provider must explicitly trust the environment used by the selected workflow; afterwards restrict
it to `prod` and remove `prod-plan`. Preserve the repository's immutable OIDC subject prefix (check
`gh api repos/OWNER/REPO/actions/oidc/customization/sub`); numeric IDs in that prefix are intentional.
Set optional `"immutable_subject": true` in the authentication/Terraform bootstrap JSON when
that API reports `use_immutable_subject: true`; omit it for legacy name-only subjects.

### Worker Concurrency

`SELFBENCH_ACTIVITY_CONCURRENCY` is ordinary configuration, not a secret. Set it on the GitHub
`dev` or `prod` environment; the full deployment preflight rejects missing or out-of-range values
before cloud authentication. The deployment records it in its request and nonsecret `release.env`.
Compose explicitly supplies that value to the worker, overriding the legacy entry if it still
exists in an older shared-secret version. New shared-secret payloads should omit it.

For example, `gh variable set SELFBENCH_ACTIVITY_CONCURRENCY --repo OWNER/REPO --env prod --body 8`
configures eight concurrent worker activities for the next deployment. No secret version change
is needed. This is a per-worker activity limit, shared by discovery, authoring, and evaluation;
it is not a live setting. The worker must be recreated through deployment to take effect, and the
rollout does not require an idle namespace.
