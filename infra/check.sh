#!/usr/bin/env bash
# Downloads pinned provider binaries; does not authenticate, read cloud state, or apply to GCP.
set -euo pipefail
cd "$(dirname "$0")/.."
export TF_IN_AUTOMATION=true
terraform fmt -check -recursive infra/terraform
bash -n infra/terraform/modules/selfbench-environment/startup.sh
python3 -m unittest discover -s infra/tests -v
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
