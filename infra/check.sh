#!/usr/bin/env bash
# Credential-free infrastructure validation.
set -euo pipefail
cd "$(dirname "$0")/.."

export TF_IN_AUTOMATION=true
terraform fmt -check -recursive infra/terraform
bash -n infra/ci/verify-source.sh

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

# The GKE worker chart renders with the values Terraform passes.
chart=infra/terraform/modules/selfbench-environment/charts/selfbench-workers
cat > "$scratch/worker-values.yaml" <<'VALUES'
image: us-central1-docker.pkg.dev/example/selfbench/selfbench@sha256:0000000000000000000000000000000000000000000000000000000000000000
runtimeAccount: selfbench-dev-runtime@example.iam.gserviceaccount.com
secrets:
  shared: projects/example/secrets/selfbench-shared-env/versions/1
  worker: projects/example/secrets/selfbench-worker-env/versions/1
  temporal: { id: selfbench-temporal-api-key, version: "1" }
temporal: { address: "us-central1.gcp.api.temporal.io:7233", namespace: example, taskQueue: selfbench-dev }
VALUES
helm lint --strict "$chart" -f "$scratch/worker-values.yaml"
helm template selfbench-workers "$chart" -f "$scratch/worker-values.yaml" >/dev/null
for target in modules/selfbench-environment environments/dev environments/prod; do
  export TF_DATA_DIR="$scratch/${target//\//-}"
  terraform -chdir="infra/terraform/$target" init -backend=false -input=false -lockfile=readonly
  terraform -chdir="infra/terraform/$target" validate
  if [[ "$target" == modules/selfbench-environment ]]; then
    terraform -chdir="infra/terraform/$target" test -no-color
  fi
done
