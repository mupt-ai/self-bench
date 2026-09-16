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
before cloud authentication. GitHub uses `dev`, `prod-plan`, and `prod` environments.
Dev deploys from main without a separate environment approval. Production planning uses ungated
`prod-plan`; apply and application deployment use `prod`, which retains required review and the
fail-closed approval check. Terraform state, inputs, and saved-plan receipts still use `prod`.
The planner's WIF subject is `environment:prod-plan`; the apply identity trusts only `environment:prod`.

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
Dev holds both identity pairs. Production's `prod-plan` holds only the plan pair; `prod` holds the
apply pair. Both production environments need identical common project/state/runtime settings.
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

## Migrating to Automatic Production Planning

Complete this setup before publishing a release containing the changed workflow. No Terraform
apply, new infrastructure, or runtime secret payload copy is needed.

1. Create `prod-plan` with no required reviewers, wait timer, or custom deployment protection rules.
   Allow exactly the `*` tag policy, not branches. Leave all `prod` protections untouched.
   `infra.bootstrap.terraform_github` now configures this split and refuses to overwrite drift.
2. Copy these variables from `prod` to `prod-plan`: `GCP_PROJECT_ID`, `TF_STATE_BUCKET`,
   `TF_PLAN_BUCKET`, `TF_INPUTS_JSON`, `GCP_PLAN_WORKLOAD_IDENTITY_PROVIDER`,
   `GCP_PLAN_SERVICE_ACCOUNT`, `RUNTIME_SECRET_VERSIONS`, and `SELFBENCH_PUBLIC_URL`.
   The bootstrap configures the first six; configure the last two separately. Do not copy apply
   identity variables or secrets. Keep shared values synchronized; mismatched inputs fail receipt verification.
3. Inspect the existing production **plan** WIF provider condition. Change only its exact subject
   from `repo:OWNER/REPO:environment:prod` to `repo:OWNER/REPO:environment:prod-plan`.
   Preserve repository/owner IDs, release-only event, tag, caller, reusable-workflow and runner checks.
   Do not change the apply provider, service-account IAM, or role permissions. The cloud bootstrap
   intentionally refuses to overwrite existing provider drift; this migration needs an explicit
   operator update and read-back verification. Old workflow releases will no longer authenticate
   their planner after this change, so coordinate the transition with queued/in-progress releases.
4. After merging, verify on the next intended stable release that planning completes automatically
   and deployment waits for review on `prod`. Approve only after reviewing the plan. Local tests
   do not establish that the live environment and WIF migration has been completed.

## Releasing Without a Dedicated Release PR

The production workflow does not require a release PR. Publish a stable GitHub release targeting
an existing commit on `main`; the tag must resolve to that commit. Normal code review and branch
policies still apply to getting changes onto `main`. Do not bypass those policies or move old tags.

This repository also publishes npm on `v*` tag pushes and checks that the tag equals
`v` plus `package.json`'s version. Include the intended version bump in a normal code PR if you
want a new npm version without a separate release-only PR. From a clean checkout of the intended
merged commit, after confirming that the version and tag are unused:

```sh
version="$(node -p "require('./package.json').version")"
tag="v$version"
git fetch origin main --tags
git merge-base --is-ancestor HEAD origin/main
git tag "$tag" HEAD
git push origin "refs/tags/$tag"
gh release create "$tag" --verify-tag --title "$tag" --generate-notes
```

These are publishing commands, not a dry run: the tag push starts npm publishing and the stable
release starts production planning. Apply/deploy still waits for `prod` approval. Publishing a
release alone does not bump the package version. Never re-publish an already-used npm version.
