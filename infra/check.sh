#!/usr/bin/env bash
# Credential-free infrastructure validation.
set -euo pipefail
cd "$(dirname "$0")/.."

export TF_IN_AUTOMATION=true
terraform fmt -check -recursive infra/terraform
bash -n infra/ci/verify-source.sh
bash -n infra/ci/new-migrations.sh

# A setting that names no variable is only a warning to Terraform, so stale ones would pile up.
for env in dev prod; do
  root="infra/terraform/environments/$env"
  unknown=$(comm -23 <(jq -r 'keys[]' "$root/terraform.tfvars.json" | sort) \
    <(sed -nE 's/^variable "([a-z0-9_]+)".*/\1/p' "$root/variables.tf" | sort))
  [[ -z "$unknown" ]] || { echo "$root/terraform.tfvars.json sets undeclared variables: $unknown" >&2; exit 1; }
done

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
for target in modules/selfbench-environment environments/dev environments/prod; do
  export TF_DATA_DIR="$scratch/${target//\//-}"
  terraform -chdir="infra/terraform/$target" init -backend=false -input=false -lockfile=readonly
  terraform -chdir="infra/terraform/$target" validate
  if [[ "$target" == modules/selfbench-environment ]]; then
    terraform -chdir="infra/terraform/$target" test -no-color
  fi
done
