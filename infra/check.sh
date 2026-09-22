#!/usr/bin/env bash
# Credential-free infrastructure validation.
set -euo pipefail
cd "$(dirname "$0")/.."

export TF_IN_AUTOMATION=true
terraform fmt -check -recursive infra/terraform
bash -n infra/ci/verify-source.sh
bash -n infra/runtime/deploy-host.sh
bash -n infra/terraform/modules/selfbench-environment/startup.sh

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
for role in shared api worker; do
  install -m 0600 /dev/null "$scratch/$role.env"
done
SELFBENCH_ENVIRONMENT=dev \
SELFBENCH_IMAGE=us-central1-docker.pkg.dev/selfbench-dev-example/selfbench/selfbench@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
SELFBENCH_ACTIVITY_CONCURRENCY=1 \
SELFBENCH_SHARED_ENV_FILE="$scratch/shared.env" \
SELFBENCH_API_ENV_FILE="$scratch/api.env" \
SELFBENCH_WORKER_ENV_FILE="$scratch/worker.env" \
  docker compose -f infra/runtime/compose.yaml config --quiet

for target in modules/selfbench-environment environments/dev environments/prod; do
  export TF_DATA_DIR="$scratch/${target//\//-}"
  terraform -chdir="infra/terraform/$target" init -backend=false -input=false -lockfile=readonly
  terraform -chdir="infra/terraform/$target" validate
  if [[ "$target" == modules/selfbench-environment ]]; then
    terraform -chdir="infra/terraform/$target" test -no-color
  fi
done
