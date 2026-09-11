"""Configure protected Terraform GitHub environments; no Terraform or GCP mutations.

python3 -m infra.bootstrap.terraform_github --config ... --inputs ... --reviewer-id ... [--execute]
"""
import argparse
import json
from pathlib import Path
import subprocess

from infra.bootstrap import github_auth, terraform_ci
from infra.ci import approval, contracts


def api(endpoint, method="GET", data=None):
    args = ["gh", "api", endpoint, "--method", method]
    if data is not None:
        args += ["--input", "-"]
    result = subprocess.run(args, input=None if data is None else json.dumps(data),
                            capture_output=True, text=True, check=True)
    return json.loads(result.stdout) if result.stdout.strip() else None


def variables(config, inputs, phase):
    coordinates = github_auth.coordinates(terraform_ci.identity(config, phase))
    return {"GCP_PROJECT_ID": config["project_id"], f"GCP_{phase.upper()}_WORKLOAD_IDENTITY_PROVIDER": coordinates["provider"],
            f"GCP_{phase.upper()}_SERVICE_ACCOUNT": coordinates["service_account"], "TF_STATE_BUCKET": config["state_bucket"],
            "TF_PLAN_BUCKET": config["plan_bucket"], "TF_INPUTS_JSON": contracts.canonical(inputs).decode()}


def execute(config, inputs, reviewer_ids):
    repo = config["repository"]
    identity = api(f"repos/{repo}")
    if (str(identity.get("id")) != config["repository_id"] or str(identity.get("owner", {}).get("id")) != config["repository_owner_id"]
            or identity.get("default_branch") != config["branch"] or not identity.get("permissions", {}).get("admin")):
        raise ValueError("Repository identity/branch/admin permission mismatch.")
    existing = api(f"repos/{repo}/environments?per_page=100")
    if existing["total_count"] > 100:
        raise ValueError("Inspect environment pagination before configuring this repository.")
    names = {entry["name"] for entry in existing["environments"]}
    ref_name = "*" if config["environment"] == "prod" else config["branch"]
    ref_type = "tag" if config["environment"] == "prod" else "branch"
    branch_policy = {"protected_branches": False, "custom_branch_policies": True}
    for phase in ("plan", "apply"):
        name = config["environment"]
        endpoint = f"repos/{repo}/environments/{name}"
        required = reviewer_ids if config["environment"] == "prod" else []
        if name not in names:
            api(endpoint, "PUT", {"deployment_branch_policy": branch_policy, "wait_timer": 0,
                                  "prevent_self_review": False,
                                  "reviewers": [{"type": "User", "id": user} for user in required]})
        names.add(name)
        environment = api(endpoint)
        actual_reviewers = sorted(user["reviewer"]["id"] for rule in environment.get("protection_rules", [])
                                  if rule.get("type") == "required_reviewers" for user in rule.get("reviewers", []))
        if environment.get("deployment_branch_policy") != branch_policy or actual_reviewers != sorted(required):
            raise ValueError("Existing environment protection differs; refusing to overwrite it.")
        policy = api(endpoint + "/deployment-branch-policies?per_page=100")
        if policy["total_count"] > 100 or any(item.get("name") != ref_name or item.get("type") != ref_type
                                            for item in policy["branch_policies"]):
            raise ValueError("Existing environment permits unexpected refs; refusing to alter it.")
        if not policy["branch_policies"]:
            api(endpoint + "/deployment-branch-policies", "POST", {"name": ref_name, "type": ref_type})
        response = api(endpoint + "/variables?per_page=100")
        if response["total_count"] > 100:
            raise ValueError("Inspect variable pagination before configuring this environment.")
        current = {item["name"]: item["value"] for item in response["variables"]}
        desired = variables(config, inputs, phase)
        for key, value in desired.items():
            if key in current:
                if current[key] != value:
                    raise ValueError(f"Existing {name}/{key} differs; review configuration drift first.")
            else:
                subprocess.run(["gh", "variable", "set", key, "--repo", repo, "--env", name, "--body", value], check=True)
        saved = {item["name"]: item["value"] for item in api(endpoint + "/variables?per_page=100")["variables"]}
        if any(saved.get(key) != value for key, value in desired.items()):
            raise ValueError("Environment variable post-state verification failed.")
        policy = api(endpoint + "/deployment-branch-policies?per_page=100")
        if phase == "apply":
            approval.verify(api(endpoint), policy, config["branch"], release=config["environment"] == "prod", require_review=config["environment"] == "prod")
        elif policy["total_count"] != 1:
            raise ValueError("Expected one exact branch restriction.")
        print(f"{name}: identity variables and environment protection verified.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--inputs", required=True, type=Path)
    parser.add_argument("--reviewer-id", action="append", required=True, type=int)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    config = terraform_ci.validate_config(json.loads(args.config.read_text()))
    inputs = json.loads(args.inputs.read_text())
    if (not isinstance(inputs, dict) or set(inputs) - contracts.INPUT_KEYS or inputs.get("project_id") != config["project_id"]):
        raise ValueError("Use only nonsecret Terraform inputs for the selected project.")
    if (not 1 <= len(args.reviewer_id) <= 6 or min(args.reviewer_id) < 1 or len(set(args.reviewer_id)) != len(args.reviewer_id)):
        raise ValueError("Choose one to six distinct reviewer user IDs.")
    if args.execute:
        execute(config, inputs, args.reviewer_id)
    else:
        print(json.dumps({"dry_run": True, "environments": {
            phase: {"environment": config["environment"], "variables": variables(config, inputs, phase),
                                               "reviewers": args.reviewer_id if config["environment"] == "prod" else []}
            for phase in ("plan", "apply")}}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"GitHub setup stopped: {error}. No existing settings were silently overwritten.") from None
