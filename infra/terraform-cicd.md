# Terraform CI/CD

SelfBench uses the same conventional deployment model for dev and prod:

- Terraform configuration lives in `infra/terraform`.
- GitHub Actions authenticates to GCP with Workload Identity Federation.
- A planner identity creates a saved plan.
- An apply identity applies that exact plan in the same protected job.
- GitHub environment protection provides the human approval boundary.
- Terraform's GCS backend provides state locking.

See [`README.md`](README.md) for required GitHub environment variables and the full deployment flow.

## Trust Boundary

Dev deploys accept the default branch through push or manual dispatch. Production deploys accept only a published, non-draft, non-prerelease GitHub release whose commit is on the default branch. `infra/ci/verify-source.sh` checks these conditions before cloud authentication.

Configure the `prod` GitHub environment to require reviewers and restrict deployments to release tags. Configure `dev` to the default branch. These repository settings are managed through GitHub rather than duplicated in repository scripts.

## Identities

Use separate service accounts for planning and applying:

- the planner needs state read/lock access and enough read access to refresh resources and create a plan;
- the apply identity needs state write access and the permissions required by the Terraform module, image publishing, database backup, and IAP deployment.

Grant only the permissions used by the workflow. Do not use service-account keys; use GitHub OIDC/WIF.

## Saved Plans

The plan remains on the ephemeral GitHub-hosted runner and is applied by path after switching identities. It is not uploaded as a public artifact. A failed or cancelled job generates a new plan on retry.

This deliberately avoids a custom plan manifest, plan bucket, or policy parser. Review the Terraform output in the protected deployment job and rely on the saved plan, environment approval, backend lock, and normal cloud audit logs.
