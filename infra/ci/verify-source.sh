#!/usr/bin/env bash
# Verify the deploy source and runtime settings before any cloud authentication.
set -euo pipefail

die() { echo "$1" >&2; exit 1; }

event_path=${GITHUB_EVENT_PATH:?Provide the GitHub event payload.}
[[ "$TF_ENVIRONMENT" == dev || "$TF_ENVIRONMENT" == prod ]] || die 'Unknown Terraform environment.'
[[ "$RUNNER_ENVIRONMENT" == github-hosted ]] || die 'Privileged deployments require a GitHub-hosted runner.'
[[ "$GITHUB_RUN_ID" =~ ^[1-9][0-9]*$ && "$GITHUB_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]] || die 'Invalid workflow run identity.'
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'Expected the exact source commit SHA.'
[[ "$GCP_PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die 'Invalid project ID.'

default_branch=$(jq -r '.repository.default_branch // ""' "$event_path")
[[ "$GITHUB_DEFAULT_BRANCH" == "$default_branch" ]] || die 'Default branch mismatch.'
[[ $(git rev-parse HEAD) == "$GITHUB_SHA" ]] || die 'Checkout differs from triggering commit.'
case "$TF_ENVIRONMENT" in
  dev)
    [[ "$GITHUB_EVENT_NAME" == push || "$GITHUB_EVENT_NAME" == workflow_dispatch ]] \
      || die 'Dev deploys must run from the default branch.'
    [[ "$GITHUB_REF" == "refs/heads/$default_branch" ]] || die 'Dev deploy source must be main.'
    ;;
  prod)
    [[ "$GITHUB_EVENT_NAME" == release ]] || die 'Production requires a published stable release tag.'
    [[ $(jq -r '.action // ""' "$event_path") == published ]] || die 'Only published stable releases may deploy production.'
    # jq's // also replaces false, so compare the raw booleans and fail closed on missing keys.
    [[ $(jq -r '.release.draft' "$event_path") == false && $(jq -r '.release.prerelease' "$event_path") == false ]] \
      || die 'Only published stable releases may deploy production.'
    tag=$(jq -r '.release.tag_name // ""' "$event_path")
    [[ "$GITHUB_REF" == "refs/tags/$tag" ]] || die 'Only published stable releases may deploy production.'
    [[ $(git rev-parse --verify "$GITHUB_REF^{commit}") == "$GITHUB_SHA" ]] || die 'Release tag moved or does not match the triggering commit.'
    ;;
esac
git merge-base --is-ancestor "$GITHUB_SHA" "refs/remotes/origin/$default_branch" \
  || die 'Deploy source is not on the default branch.'

case "${INFRASTRUCTURE_ONLY:-false}" in
  true)
    [[ "$TF_ENVIRONMENT" == dev && "$GITHUB_EVENT_NAME" == workflow_dispatch ]] \
      || die 'Infrastructure-only bootstrap must be an explicit manual dev run.'
    echo "Verified deploy source $GITHUB_SHA for infrastructure-only bootstrap."
    exit 0
    ;;
  false) ;;
  *) die 'Invalid infrastructure-only flag.' ;;
esac

jq -e 'type=="object" and keys==["api","shared","worker"]
       and ([.[] | tostring | test("^[1-9][0-9]*$")] | all)' \
    <<<"${RUNTIME_SECRET_VERSIONS:-}" >/dev/null \
  || die 'Configure exact shared/api/worker Secret Manager versions before deploying.'
[[ "${SELFBENCH_PUBLIC_URL:-}" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || die 'Configure the public HTTPS origin.'
[[ "${SELFBENCH_ACTIVITY_CONCURRENCY:-}" =~ ^[1-8]$ ]] || die 'Configure activity concurrency as an integer from 1 to 8.'
echo "Verified deploy source $GITHUB_SHA and runtime settings."
