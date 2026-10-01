#!/usr/bin/env bash
# Whether this release brings database migrations the environment has not run yet. Every
# migration lives in drizzle/ (src/db/client.ts), and a deploy only succeeds once the new API is
# up, which needs its migrations run. So when drizzle/ is the same as at the last commit this
# workflow deployed successfully, there is nothing new to run. Writes new=false to GITHUB_OUTPUT
# only then; anything uncertain (no earlier deploy found, an API error, history that does not
# line up) writes new=true.
set -uo pipefail

decide() {
  echo "new=$1" >> "$GITHUB_OUTPUT"
  echo "$2"
  exit 0
}

repo=${GITHUB_REPOSITORY:?}
workflow=$(gh api "repos/$repo/actions/runs/${GITHUB_RUN_ID:?}" --jq .workflow_id) \
  || decide true "Could not read this run; backing up."
runs=$(gh api "repos/$repo/actions/workflows/$workflow/runs?branch=${GITHUB_DEFAULT_BRANCH:?}&status=success&per_page=30" \
  --jq ".workflow_runs[] | select(.id != $GITHUB_RUN_ID) | \"\(.id) \(.head_sha)\"") \
  || decide true "Could not list earlier deploys; backing up."

# A successful run whose deploy job succeeded: a run can succeed with its deploy job skipped.
last=""
while read -r run sha; do
  [[ -n "$run" ]] || continue
  deployed=$(gh api "repos/$repo/actions/runs/$run/jobs" \
    --jq "[.jobs[] | select(.name | endswith(\" / ${GITHUB_JOB:?}\")) | .conclusion] | first // \"\"") \
    || continue
  if [[ "$deployed" == success ]]; then
    last=$sha
    break
  fi
done <<<"$runs"

[[ -n "$last" ]] || decide true "No earlier successful deploy found; backing up."
git merge-base --is-ancestor "$last" "${GITHUB_SHA:?}" 2>/dev/null \
  || decide true "The last deploy ($last) is not an ancestor of this commit; backing up."
if git diff --quiet "$last" "$GITHUB_SHA" -- drizzle; then
  decide false "No new migrations since the last deploy ($last)."
fi
decide true "Migrations changed since the last deploy ($last); backing up."
