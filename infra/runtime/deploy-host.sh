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
if ! command -v jq >/dev/null; then
  apt-get update
  apt-get install -y jq
fi
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

# Every release pulls a new image; without pruning they accumulate until the boot disk
# fills and the running API can no longer serve. Artifact Registry keeps every digest,
# so only the running image (the rollback target) and the incoming one stay local.
previous_image=
if [[ -f $state/current-release ]]; then
  previous_image=$(sed -n 's/^SELFBENCH_IMAGE=//p' "$(cat "$state/current-release")/release.env")
fi
prune_images() {
  local ref
  while read -r ref; do
    [[ $ref == "$image" || $ref == "$previous_image" ]] && continue
    docker image rm "$ref" >/dev/null || echo "Could not remove $ref; leaving it." >&2
  done < <(docker image ls --digests --format '{{.Repository}}@{{.Digest}}' "${image%@*}")
  docker image prune --force >/dev/null
}
prune_images
docker_root=$(docker info --format '{{.DockerRootDir}}')
free_gb=$(df --output=avail -BG "$docker_root" | tail -n 1 | tr -dc '0-9')
(( free_gb >= 10 )) || fail "only ${free_gb}G free under $docker_root; free disk space before deploying"

mkdir "$release"
source_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
install -m 0600 "$source_dir/compose.yaml" "$release/compose.yaml"
install -m 0644 "$source_dir/deploy-check.mjs" "$release/deploy-check.mjs"

# The API's bundle is Cloud Run's; this VM runs only the worker.
for role in shared worker; do
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
"${compose[@]}" stop worker
migration="const {openDatabase}=await import('/app/dist/db/client.js'); const c=await openDatabase(process.env.SELFBENCH_DATABASE_URL); await c.close();"
docker run --rm --env-file "$release/shared.env" "$image" node --input-type=module -e "$migration"
# --remove-orphans drops the API container releases before Cloud Run left behind.
"${compose[@]}" up -d --wait --wait-timeout 180 --remove-orphans

for attempt in {1..12}; do
  if "${check[@]}" worker; then
    break
  fi
  [[ $attempt -lt 12 ]] || fail "worker did not register with Temporal"
  sleep 5
done
# The site moved to Cloud Run; stop the old host proxy (its firewall rule is gone too).
if systemctl is-enabled --quiet caddy 2>/dev/null; then
  systemctl disable --now caddy
fi
printf '%s\n' "$release" > "$state/current-release"
prune_images
echo "Release, migrations and recent worker polling verified."
