# GitHub → GCP Authentication (Opt-In)

This is the **authentication bootstrap**, not Terraform provisioning or application deployment.
It establishes keyless CI identities and a manually triggered token-exchange check. It does not grant
project resource roles, access to Terraform state, registry publishing, or deployment permissions.

The public code is reusable: every project/account/repository identity comes from operator input or
GitHub environment variables. It does not assume a particular organization, project-name prefix,
or environment name. The existing infrastructure/runtime examples still have their own narrower
constraints; this auth bootstrap does not silently change them.

## 1. Collect and Review Identity Information

- Existing GCP project ID and **project number**, plus the explicit operator account.
- GitHub repository full name, numeric repository ID, numeric owner ID and default branch.
- GitHub environment name and dedicated pool/provider/service-account IDs.

Use read-only discovery:

```sh
gcloud projects describe PROJECT_ID --account=OPERATOR --format=json
gh api repos/OWNER/REPO --jq '{full_name,id,owner_id:.owner.id,default_branch}'
```

Copy `bootstrap/github-auth.json.example` to an operator file outside the checkout, or an ignored
`*.local.json` file. The config contains identifiers, not credentials. Choose a distinct project
and config for production. No account or organization identifiers need to be committed.

```sh
# Offline: prints planned commands; makes no gcloud or GitHub calls.
python3 infra/bootstrap/github_auth.py --config /PRIVATE/LOCATION/dev.json

# After reviewing the target identities and trust policy:
python3 infra/bootstrap/github_auth.py --config /PRIVATE/LOCATION/dev.json --execute
```

The executing operator needs permission to enable IAM/STS APIs, manage identity pools and service
accounts, and bind workload identities on the new service account. No service-account private key is
created or downloaded. The script verifies the project and repository IDs before its first mutation.

It creates a dedicated single-provider pool and service account, or verifies an exact existing match.
It refuses unrelated providers in the pool, altered trust, disabled identities, unexpected direct
service-account bindings, direct project grants, or user-managed keys. A failure can leave a partial
bootstrap; inspect it before retrying. Matching resources can resume without recreating or rebinding.
Post-create reads retry only `NOT_FOUND` for a bounded 15-second backoff; mutations and permission
errors are never blindly retried. It does not inventory every possible inherited or resource-level grant: use newly dedicated identities.

## 2. Configure GitHub Environments

Create the named environments in the repository's Actions settings. Use a custom deployment branch
policy allowing only the configured default branch (not similarly named tags). Require a human reviewer
for the production environment. Do not replace an existing environment's protections or variables
without reviewing them. With one maintainer, allowing that maintainer to approve their own manual run
is an explicit policy choice; it still requires a separate approval click.

Set these **nonsecret environment variables** to the verified bootstrap output:

| Variable | Value |
| --- | --- |
| `GCP_PROJECT_ID` | This environment's existing GCP project |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full `projects/NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER` |
| `GCP_SERVICE_ACCOUNT` | This environment's dedicated CI service-account email |

For example:

```sh
gh variable set GCP_PROJECT_ID --repo OWNER/REPO --env ENVIRONMENT --body PROJECT_ID
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo OWNER/REPO --env ENVIRONMENT --body PROVIDER_RESOURCE
gh variable set GCP_SERVICE_ACCOUNT --repo OWNER/REPO --env ENVIRONMENT --body SERVICE_ACCOUNT_EMAIL
# Explicit repository-level opt-in, after configuring and verifying the environments:
gh variable set GCP_AUTH_ENABLED --repo OWNER/REPO --body true
```

Do not create a GitHub secret containing a service-account key. Unconfigured repositories/forks skip
the auth job, while their ordinary credential-free validation remains available.

## 3. Verify the Exchange After Merging the Workflow

The auth workflow must exist on the configured default branch before it can be dispatched:

```sh
gh workflow run gcp-auth.yml --repo OWNER/REPO --ref DEFAULT_BRANCH -f environment=ENVIRONMENT
```

Observe that exact run through completion; a workflow file or successful cloud bootstrap alone does
not prove a GitHub token exchange. The job checks configuration, exchanges GitHub OIDC for a short-lived
service-account token, checks that the token exists without displaying it, and stops. No credential
file, persistent key, Terraform plan/apply, or application release is created. Production waits for its
configured GitHub environment approval.

The cloud trust policy requires **all** of:

- Matching numeric repository **and** numeric owner IDs (not reusable names alone).
- Exact repository name and environment-bound OIDC subject.
- Exact default-branch ref and auth workflow path/ref.
- `workflow_dispatch` event and a GitHub-hosted runner.

Forks, PR events (including `pull_request_target`), other branches, other environments and other
workflows do not satisfy this policy. The principal-set binding is restricted to the repository ID;
the dedicated pool prevents a second, weaker provider from claiming the same attribute. There is no
custom audience override or alternate issuer/JWKS in this setup.

Trust is intentionally narrower than a future deployment pipeline. Adding a main-push planning
workflow requires a separately reviewed policy change and scoped plan/state permissions. Do not
silently broaden this auth-only identity into a production apply identity. Use separate apply identities
and approval gates when that stage is implemented.

## Validation and Reversal

Local validation: `bash infra/check.sh`, including offline CLI tests, strict trust-policy regression
tests and existing mocked infrastructure tests. No simulated claim test is a substitute for an actual
GitHub-issued OIDC exchange. CLI flags were checked with Google Cloud SDK 569.0.0; the auth action is
pinned to a verified v3 commit, checkout to a verified v4 commit. Use a current GitHub-hosted runner.

To stop new auth runs, set `GCP_AUTH_ENABLED=false`. To revoke cloud trust, disable the named provider
or remove its exact workload-identity binding after reviewing the target. This does not revoke tokens
already issued; the auth-check workflow requests five-minute tokens. Do not delete the project, state
bucket, unrelated environments or unrelated IAM policies to undo authentication bootstrap. Record the
pre/post policies and preserve existing protections when making changes.
