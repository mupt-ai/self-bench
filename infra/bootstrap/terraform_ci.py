"""Opt-in Terraform CI identity/permission bootstrap, never a Terraform apply.

Run from the repo root with: python3 -m infra.bootstrap.terraform_ci --config ... [--execute]
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile

from infra.bootstrap import github_auth as auth

DESCRIPTION = "SelfBench Terraform CI; managed by infra/bootstrap/terraform_ci.py"
ROLE_IDS = {"plan": "selfbenchTerraformPlan", "apply": "selfbenchTerraformApply", "lock": "selfbenchTerraformLock"}


def identity(config, phase):
    return auth.validate_config({key: config[key] for key in (
        "account", "project_id", "project_number", "repository", "repository_id", "repository_owner_id", "branch"
    )} | {"environment": config["environment"], "workflow_path": f".github/workflows/deploy-{config['environment']}.yml",
          "pool_id": f"{config['identity_prefix']}-{phase}", "provider_id": "github",
          "service_account_id": f"{config['identity_prefix']}-{phase}"})


def validate_config(config):
    expected = {"account", "project_id", "project_number", "repository", "repository_id", "repository_owner_id",
                "branch", "environment", "identity_prefix", "state_bucket", "plan_bucket", "region"}
    if set(config) != expected or config.get("environment") not in ("dev", "prod"):
        raise ValueError("Use terraform-ci.json.example and select one existing dev/prod root.")
    for field in ("state_bucket", "plan_bucket"):
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", config[field]):
            raise ValueError(f"Invalid {field}.")
    if config["state_bucket"] == config["plan_bucket"]:
        raise ValueError("State and saved plans require distinct buckets.")
    if not re.fullmatch(r"[a-z]+-[a-z]+[0-9]", config["region"]):
        raise ValueError("Invalid region.")
    identity(config, "plan")
    identity(config, "apply")
    return config


def permissions():
    definitions = json.loads(Path(__file__).with_name("terraform-permissions.json").read_text())
    plan = sorted(set(definitions["plan"]))
    return {"plan": plan, "apply": sorted(set(plan + definitions["apply_extra"])),
            "lock": ["storage.objects.create", "storage.objects.delete", "storage.objects.get"]}


def events(config):
    return ("push", "workflow_dispatch") if config["environment"] == "dev" else ("release",)


def role_name(config, phase):
    return f"projects/{config['project_id']}/roles/{ROLE_IDS[phase]}"


def mutate(config, *parts):
    subprocess.run(auth.command(config, *parts), check=True, stdout=subprocess.DEVNULL)


def verify_bucket(config, bucket):
    metadata = auth.read(config, "storage", "buckets", "describe", f"gs://{bucket}", "--raw")
    iam = metadata.get("iamConfiguration", {})
    if (str(metadata.get("projectNumber")) != config["project_number"]
            or metadata.get("location", "").lower() != config["region"]
            or iam.get("publicAccessPrevention") != "enforced"
            or iam.get("uniformBucketLevelAccess", {}).get("enabled") is not True
            or metadata.get("versioning", {}).get("enabled") is not True):
        raise ValueError("Bucket ownership/location/protections do not match the approved configuration.")


def state_lock_condition(config):
    object_name = f"projects/_/buckets/{config['state_bucket']}/objects/selfbench/{config['environment']}/default.tflock"
    return {"title": "terraform-state-lock-only", "expression": f"resource.name == '{object_name}'"}


def ensure_bucket_binding(config, bucket, member, role, condition=None):
    # Read/check/add a single member, never replace an entire bucket policy.
    policy = auth.read(config, "storage", "buckets", "get-iam-policy", f"gs://{bucket}")
    for binding in policy.get("bindings", []):
        if binding.get("role") == role and member in binding.get("members", []):
            if binding.get("condition") != condition:
                raise ValueError("Existing bucket grant has a different condition; refusing to broaden it.")
            return
    if condition:
        flag = "--condition=" + ",".join(f"{key}={value}" for key, value in condition.items())
    else:
        flag = "--condition=None"
    mutate(config, "storage", "buckets", "add-iam-policy-binding", f"gs://{bucket}",
           f"--member={member}", f"--role={role}", flag)
    verified = auth.read(config, "storage", "buckets", "get-iam-policy", f"gs://{bucket}")
    if not any(b.get("role") == role and member in b.get("members", []) and b.get("condition") == condition
               for b in verified.get("bindings", [])):
        raise ValueError("Bucket IAM grant was not confirmed.")


def ensure_roles(config):
    existing = auth.read(config, "iam", "roles", "list")
    definitions = permissions()
    # Validate against the actual permission catalogue, not guessed role names.
    catalogue = auth.read(config, "iam", "list-testable-permissions",
                          f"//cloudresourcemanager.googleapis.com/projects/{config['project_id']}")
    supported = {item["name"] for item in catalogue if item.get("customRolesSupportLevel") != "NOT_SUPPORTED"}
    missing = set().union(*map(set, definitions.values())) - supported
    if missing:
        raise ValueError(f"Permissions not supported by the selected project: {sorted(missing)}")
    for phase, entries in definitions.items():
        fresh = not any(role.get("name") == role_name(config, phase) for role in existing)
        if fresh:
            with tempfile.TemporaryDirectory() as directory:
                filename = Path(directory) / "role.json"
                filename.write_text(json.dumps({"title": f"SelfBench Terraform {phase}", "description": DESCRIPTION,
                                                "stage": "GA", "includedPermissions": entries}))
                mutate(config, "iam", "roles", "create", ROLE_IDS[phase], f"--file={filename}")
        role = auth.read_after_create(config, "iam", "roles", "describe", ROLE_IDS[phase], fresh=fresh)
        if (role.get("name") != role_name(config, phase) or role.get("description") != DESCRIPTION
                or role.get("deleted", False) or role.get("stage") != "GA"
                or set(role.get("includedPermissions", [])) != set(entries)):
            raise ValueError("Existing custom role differs; review rather than overwriting it.")


def execute(config):
    project = auth.read(config, "projects", "describe", config["project_id"])
    if str(project.get("projectNumber")) != config["project_number"] or project.get("lifecycleState") != "ACTIVE":
        raise ValueError("Project identity mismatch.")
    repository = json.loads(subprocess.check_output(["gh", "api", f"repos/{config['repository']}"], text=True))
    if (repository.get("full_name") != config["repository"] or str(repository.get("id")) != config["repository_id"]
            or str(repository.get("owner", {}).get("id")) != config["repository_owner_id"]
            or repository.get("default_branch") != config["branch"] or not repository.get("permissions", {}).get("admin")):
        raise ValueError("Repository identity/default branch or administrative access differs.")
    # State must already exist: a read-only planner cannot initialize a new state snapshot.
    verify_bucket(config, config["state_bucket"])
    auth.read(config, "storage", "objects", "describe",
              f"gs://{config['state_bucket']}/selfbench/{config['environment']}/default.tfstate")
    existing = auth.read(config, "storage", "buckets", "list")
    if not any(bucket.get("name") == config["plan_bucket"] for bucket in existing):
        mutate(config, "storage", "buckets", "create", f"gs://{config['plan_bucket']}",
               f"--location={config['region']}", "--uniform-bucket-level-access", "--public-access-prevention")
        mutate(config, "storage", "buckets", "update", f"gs://{config['plan_bucket']}", "--versioning")
    verify_bucket(config, config["plan_bucket"])
    ensure_roles(config)
    outputs = {}
    for phase in ("plan", "apply"):
        account_config = identity(config, phase)
        auth.execute(account_config, events=events(config), allowed_project_roles=(role_name(config, phase),))
        coordinates = auth.coordinates(account_config)
        member = f"serviceAccount:{coordinates['service_account']}"
        mutate(config, "projects", "add-iam-policy-binding", config["project_id"],
               f"--member={member}", f"--role={role_name(config, phase)}", "--condition=None")
        state_roles = ["roles/storage.objectViewer"] if phase == "plan" else ["roles/storage.objectAdmin"]
        for role in state_roles:
            ensure_bucket_binding(config, config["state_bucket"], member, role)
        if phase == "plan":
            ensure_bucket_binding(config, config["state_bucket"], member, role_name(config, "lock"), state_lock_condition(config))
            ensure_bucket_binding(config, config["plan_bucket"], member, "roles/storage.objectCreator")
        ensure_bucket_binding(config, config["plan_bucket"], member, "roles/storage.objectViewer")
        if phase == "apply":
            log_prefix = f"projects/_/buckets/{config['plan_bucket']}/objects/apply-logs/"
            ensure_bucket_binding(config, config["plan_bucket"], member, "roles/storage.objectCreator",
                                  {"title": "terraform-apply-logs-only", "expression": f"resource.name.startsWith('{log_prefix}')"})
        verified = auth.read(config, "projects", "get-iam-policy", config["project_id"])
        direct_roles = {binding["role"] for binding in verified.get("bindings", []) if member in binding.get("members", [])}
        if direct_roles != {role_name(config, phase)}:
            raise ValueError("CI identity project permissions do not match its one intended role.")
        outputs[f"{config['environment']}-{phase}"] = {
            "GCP_PROJECT_ID": config["project_id"], "GCP_WORKLOAD_IDENTITY_PROVIDER": coordinates["provider"],
            "GCP_SERVICE_ACCOUNT": coordinates["service_account"], "TF_STATE_BUCKET": config["state_bucket"],
            "TF_PLAN_BUCKET": config["plan_bucket"],
        }
    print(json.dumps(outputs, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    config = validate_config(json.loads(args.config.read_text()))
    if args.execute:
        execute(config)
    else:
        print(json.dumps({"project": config["project_id"], "environment": config["environment"],
                          "private_plan_bucket": config["plan_bucket"], "roles": permissions(),
                          "identities": {phase: auth.coordinates(identity(config, phase)) for phase in ("plan", "apply")},
                          "events": events(config), "state_lock_condition": state_lock_condition(config),
                          "dry_run": True}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"CI bootstrap stopped: {error}. Inspect partial state before retrying.") from None
