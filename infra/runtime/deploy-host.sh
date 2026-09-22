#!/usr/bin/env bash
# Run as root on the selected VM with a reviewed release request.
set -euo pipefail
umask 077

fail() {
  echo "VM deployment failed: $1" >&2
  exit 1
}

[[ ${EUID:-$(id -u)} -eq 0 ]] || fail "run as root"
[[ $# -eq 1 && -f "$1" ]] || fail "provide one release request"
command -v jq >/dev/null || fail "jq is required"
command -v docker >/dev/null || fail "Docker is required"

request=$1
project=$(jq -er '.project | select(type == "string")' "$request")
environment=$(jq -er '.environment | select(. == "dev" or . == "prod")' "$request")
jq -e '.sha | select(type == "string" and test("^[0-9a-f]{40}$"))' "$request" >/dev/null \
  || fail "invalid source SHA"
release_id=$(jq -er '.release_id | select(test("^[0-9a-f]{40}-[1-9][0-9]*-[1-9][0-9]*$"))' "$request")
image=$(jq -er '.image | select(type == "string")' "$request")
registry=$(jq -er '.registry | select(test("^[a-z]+-[a-z]+[0-9]-docker\\.pkg\\.dev$"))' "$request")
concurrency=$(jq -er '.activity_concurrency | select(test("^([1-9][0-9]?|100)$"))' "$request")
[[ $project =~ ^selfbench-$environment-[a-z0-9-]+[a-z0-9]$ ]] || fail "invalid project"
[[ $image =~ ^$registry/$project/selfbench/selfbench@sha256:[0-9a-f]{64}$ ]] || fail "image is not an immutable digest from the target project"
[[ $(jq -r '.secret_versions | type' "$request") == object ]] || fail "invalid secret versions"
[[ $(jq -r '.secret_versions | keys | join(",")' "$request") == api,shared,worker ]] || fail "invalid secret roles"

metadata=http://metadata.google.internal/computeMetadata/v1
metadata_header='Metadata-Flavor: Google'
actual_project=$(curl --fail --silent --show-error --max-time 15 -H "$metadata_header" "$metadata/project/project-id")
[[ $actual_project == "$project" ]] || fail "wrong VM project"
token=$(curl --fail --silent --show-error --max-time 15 -H "$metadata_header" \
  "$metadata/instance/service-accounts/default/token" | jq -er '.access_token')

state=/opt/selfbench
mkdir -p "$state/releases"
exec 9>"$state/deploy.lock"
flock -n 9 || fail "another deployment is running"
release="$state/releases/$release_id"
mkdir "$release"
source_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
install -m 0600 "$source_dir/compose.yaml" "$release/compose.yaml"
install -m 0644 "$source_dir/deploy-check.mjs" "$release/deploy-check.mjs"

for role in shared api worker; do
  version=$(jq -er --arg role "$role" '.secret_versions[$role] | tostring | select(test("^[1-9][0-9]*$"))' "$request")
  url="https://secretmanager.googleapis.com/v1/projects/$project/secrets/selfbench-$role-env/versions/$version:access"
  curl --fail --silent --show-error --max-time 30 -H "Authorization: Bearer $token" "$url" \
    | jq -er '.payload.data' | base64 --decode > "$release/$role.env"
  chmod 0600 "$release/$role.env"
done

cat > "$release/release.env" <<EOF
SELFBENCH_ENVIRONMENT=$environment
SELFBENCH_IMAGE=$image
SELFBENCH_ACTIVITY_CONCURRENCY=$concurrency
SELFBENCH_SHARED_ENV_FILE=$release/shared.env
SELFBENCH_API_ENV_FILE=$release/api.env
SELFBENCH_WORKER_ENV_FILE=$release/worker.env
EOF
chmod 0600 "$release/release.env"

compose=(docker compose --env-file "$release/release.env" -f "$release/compose.yaml")
auth_dir=$(mktemp -d)
cleanup() { rm -rf "$auth_dir"; }
trap cleanup EXIT
export DOCKER_CONFIG=$auth_dir
printf '%s' "$token" | docker login --username oauth2accesstoken --password-stdin "$registry" >/dev/null
"${compose[@]}" config --quiet
"${compose[@]}" pull

check=(docker run --rm --env-file "$release/shared.env" --env-file "$release/worker.env"
  -v "$release/deploy-check.mjs:/app/deploy-check.mjs:ro" "$image" node /app/deploy-check.mjs)
"${compose[@]}" stop api worker 2>/dev/null || true
migration="const {openDatabase}=await import('/app/dist/db/client.js'); const c=await openDatabase(process.env.SELFBENCH_DATABASE_URL); await c.close();"
docker run --rm --env-file "$release/shared.env" "$image" node --input-type=module -e "$migration"
"${compose[@]}" up -d --wait --wait-timeout 180

for attempt in {1..12}; do
  if "${check[@]}" worker; then
    break
  fi
  [[ $attempt -lt 12 ]] || fail "worker did not register with Temporal"
  sleep 5
done
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:8080/healthz >/dev/null
printf '%s\n' "$release" > "$state/current-release"
echo "Release, migrations, API health and recent worker polling verified."
