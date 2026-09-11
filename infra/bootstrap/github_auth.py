#!/usr/bin/env python3
"""Configure keyless GitHub authentication only. Defaults to an offline dry run."""
import argparse
import json
from pathlib import Path
import re
import shlex
import subprocess
import time

DESCRIPTION = "SelfBench GitHub OIDC; managed by infra/bootstrap/github_auth.py"
MAPPING = {
    "google.subject": "assertion.sub",
    "attribute.repository_id": "assertion.repository_id",
    "attribute.repository_owner_id": "assertion.repository_owner_id",
}


def validate_config(config):
    patterns = {
        "account": r"[^\s@]+@[^\s@]+",
        "project_id": r"[a-z][a-z0-9-]{4,28}[a-z0-9]",
        "project_number": r"[0-9]+",
        "repository": r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+",
        "repository_id": r"[0-9]+",
        "repository_owner_id": r"[0-9]+",
        "environment": r"[a-z][a-z0-9-]{0,31}",
        "branch": r"[A-Za-z0-9][A-Za-z0-9/_.-]*",
        "workflow_path": r"\.github/workflows/[A-Za-z0-9_-]+\.ya?ml",
        "pool_id": r"[a-z][a-z0-9-]{2,30}[a-z0-9]",
        "provider_id": r"[a-z][a-z0-9-]{2,30}[a-z0-9]",
        "service_account_id": r"[a-z][a-z0-9-]{4,28}[a-z0-9]",
    }
    if set(config) != set(patterns):
        raise ValueError("Configuration keys must match github-auth.json.example exactly.")
    for key, pattern in patterns.items():
        if not isinstance(config[key], str) or not re.fullmatch(pattern, config[key]):
            raise ValueError(f"Invalid configuration field: {key}")
    if any(config[key].startswith("gcp-") for key in ("pool_id", "provider_id")):
        raise ValueError("The gcp- identity pool/provider prefix is reserved.")
    if ".." in config["branch"] or config["branch"].endswith(("/", ".")):
        raise ValueError("Use a valid Git branch name.")
    return config


def claims(config):
    return {
        "repository_id": config["repository_id"],
        "repository_owner_id": config["repository_owner_id"],
        "repository": config["repository"],
        "sub": f"repo:{config['repository']}:environment:{config['environment']}",
        "ref": f"refs/heads/{config['branch']}",
        "workflow_ref": f"{config['repository']}/{config['workflow_path']}@refs/heads/{config['branch']}",
        "event_name": "workflow_dispatch",
        "runner_environment": "github-hosted",
    }


def condition(config, events=("workflow_dispatch",)):
    if not events or len(set(events)) != len(events) or not set(events) <= {"push", "workflow_dispatch", "release"}:
        raise ValueError("Only explicit default-branch push/manual events may be trusted.")
    if "release" in events:
        if events != ("release",):
            raise ValueError("Release trust cannot be mixed with branch events.")
        base = claims(config)
        clauses = [f"assertion.{key} == '{base[key]}'" for key in
                   ("repository_id", "repository_owner_id", "repository", "sub", "runner_environment")]
        clauses.extend(["assertion.event_name == 'release'", "assertion.ref.startsWith('refs/tags/')",
                        f"assertion.workflow_ref == '{config['repository']}/{config['workflow_path']}@' + assertion.ref",
                        f"assertion.job_workflow_ref == '{config['repository']}/.github/workflows/deploy-reusable.yml@' + assertion.ref"])
        return " && ".join(clauses)
    clauses = []
    for key, value in claims(config).items():
        if key == "event_name" and len(events) > 1:
            clauses.append("(" + " || ".join(f"assertion.event_name == '{event}'" for event in events) + ")")
        else:
            clauses.append(f"assertion.{key} == '{events[0] if key == 'event_name' else value}'")
    if config["workflow_path"] == ".github/workflows/deploy-dev.yml":
        clauses.append(f"assertion.job_workflow_ref == '{config['repository']}/.github/workflows/deploy-reusable.yml@refs/heads/{config['branch']}'")
    return " && ".join(clauses)


def coordinates(config):
    pool = f"projects/{config['project_number']}/locations/global/workloadIdentityPools/{config['pool_id']}"
    return {
        "pool": pool,
        "provider": f"{pool}/providers/{config['provider_id']}",
        "service_account": f"{config['service_account_id']}@{config['project_id']}.iam.gserviceaccount.com",
        "member": f"principalSet://iam.googleapis.com/{pool}/attribute.repository_id/{config['repository_id']}",
    }


def command(config, *parts):
    return ["gcloud", *parts, f"--project={config['project_id']}",
            f"--account={config['account']}", "--quiet"]


def read(config, *parts):
    result = subprocess.run(command(config, *parts, "--format=json"), check=True,
                            capture_output=True, text=True)
    return json.loads(result.stdout)



def read_after_create(config, *parts, fresh):
    """New IAM resources can briefly return NOT_FOUND. Retry reads, never mutations."""
    pauses = (0, 1, 2, 4, 8) if fresh else (0,)
    for index, pause in enumerate(pauses):
        if pause:
            time.sleep(pause)
        try:
            return read(config, *parts)
        except subprocess.CalledProcessError as error:
            if "NOT_FOUND:" not in (error.stderr or "") or index == len(pauses) - 1:
                raise


def planned_commands(config, events=("workflow_dispatch",)):
    names = coordinates(config)
    pool_args = ["--location=global", f"--workload-identity-pool={config['pool_id']}"]
    return [
        command(config, "services", "enable", "iam.googleapis.com", "iamcredentials.googleapis.com", "sts.googleapis.com"),
        command(config, "iam", "workload-identity-pools", "create", config["pool_id"],
                "--location=global", "--display-name=GitHub Actions", f"--description={DESCRIPTION}"),
        command(config, "iam", "workload-identity-pools", "providers", "create-oidc", config["provider_id"],
                *pool_args, "--issuer-uri=https://token.actions.githubusercontent.com",
                "--attribute-mapping=" + ",".join(f"{key}={value}" for key, value in MAPPING.items()),
                f"--attribute-condition={condition(config, events)}", f"--description={DESCRIPTION}"),
        command(config, "iam", "service-accounts", "create", config["service_account_id"],
                "--display-name=SelfBench CI authentication", f"--description={DESCRIPTION}"),
        command(config, "iam", "service-accounts", "add-iam-policy-binding", names["service_account"],
                "--role=roles/iam.workloadIdentityUser", f"--member={names['member']}", "--condition=None"),
    ]


def verify_provider(config, provider, events=("workflow_dispatch",)):
    expected = coordinates(config)["provider"]
    oidc = provider.get("oidc", {})
    if (provider.get("name") != expected or provider.get("state") != "ACTIVE" or provider.get("disabled", False)
            or provider.get("description") != DESCRIPTION
            or provider.get("attributeMapping") != MAPPING
            or provider.get("attributeCondition") != condition(config, events)
            or oidc.get("issuerUri") != "https://token.actions.githubusercontent.com"
            or oidc.get("allowedAudiences") or oidc.get("jwksJson")):
        raise ValueError("Provider identity/trust differs; refusing to adopt or overwrite it.")


def verify_bindings(config, policy):
    expected = {"role": "roles/iam.workloadIdentityUser", "members": [coordinates(config)["member"]]}
    bindings = policy.get("bindings", [])
    if bindings and bindings != [expected]:
        raise ValueError("Service account has unexpected IAM bindings; refusing to broaden trust.")
    return bool(bindings)


def execute(config, events=("workflow_dispatch",), allowed_project_roles=()):
    names, commands = coordinates(config), planned_commands(config, events)
    project = read(config, "projects", "describe", config["project_id"])
    repo = json.loads(subprocess.check_output(["gh", "api", f"repos/{config['repository']}"], text=True))
    if (project.get("projectId") != config["project_id"]
            or str(project.get("projectNumber")) != config["project_number"]
            or project.get("lifecycleState") != "ACTIVE"):
        raise ValueError("Project identity does not match the reviewed configuration.")
    if (repo.get("full_name") != config["repository"] or str(repo.get("id")) != config["repository_id"]
            or str(repo.get("owner", {}).get("id")) != config["repository_owner_id"]
            or repo.get("default_branch") != config["branch"]):
        raise ValueError("Repository identity/default branch does not match the reviewed configuration.")
    subprocess.run(commands[0], check=True)
    pools = read(config, "iam", "workload-identity-pools", "list", "--location=global")
    new_pool = not any(pool.get("name") == names["pool"] for pool in pools)
    if new_pool:
        subprocess.run(commands[1], check=True)
    pool = read_after_create(config, "iam", "workload-identity-pools", "describe", config["pool_id"],
                             "--location=global", fresh=new_pool)
    if (pool.get("name") != names["pool"] or pool.get("state") != "ACTIVE"
            or pool.get("disabled", False) or pool.get("description") != DESCRIPTION):
        raise ValueError("Pool identity/state differs; refusing adoption.")
    scope = ["--location=global", f"--workload-identity-pool={config['pool_id']}"]
    providers = read(config, "iam", "workload-identity-pools", "providers", "list", *scope)
    if any(provider.get("name") != names["provider"] for provider in providers):
        raise ValueError("A dedicated, single-provider pool is required for this trust boundary.")
    if not providers:
        subprocess.run(commands[2], check=True)
    verify_provider(config, read_after_create(config, "iam", "workload-identity-pools", "providers", "describe",
                                              config["provider_id"], *scope, fresh=not providers), events)
    accounts = read(config, "iam", "service-accounts", "list")
    new_account = not any(account.get("email") == names["service_account"] for account in accounts)
    if new_account:
        subprocess.run(commands[3], check=True)
    account = read_after_create(config, "iam", "service-accounts", "describe", names["service_account"],
                                fresh=new_account)
    if (account.get("email") != names["service_account"] or account.get("description") != DESCRIPTION
            or account.get("disabled", False)):
        raise ValueError("Service account identity/state differs; refusing adoption.")
    # This step establishes authentication, NOT cloud resource or Terraform state authorization.
    project_policy = read(config, "projects", "get-iam-policy", config["project_id"])
    existing_roles = {binding["role"] for binding in project_policy.get("bindings", [])
                      if f"serviceAccount:{names['service_account']}" in binding.get("members", [])}
    if existing_roles - set(allowed_project_roles):
        raise ValueError("Service account has unexpected project roles; review instead of reusing.")
    if read(config, "iam", "service-accounts", "keys", "list", f"--iam-account={names['service_account']}", "--managed-by=user"):
        raise ValueError("Authentication-only account has user-managed keys; review instead of reusing.")
    policy = read(config, "iam", "service-accounts", "get-iam-policy", names["service_account"])
    if not verify_bindings(config, policy):
        subprocess.run(commands[4], check=True)
    if not verify_bindings(config, read(config, "iam", "service-accounts", "get-iam-policy", names["service_account"])):
        raise ValueError("Workload identity binding was not confirmed.")
    print(json.dumps({"GCP_PROJECT_ID": config["project_id"], "GCP_WORKLOAD_IDENTITY_PROVIDER": names["provider"],
                      "GCP_SERVICE_ACCOUNT": names["service_account"]}, indent=2))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    config = validate_config(json.loads(args.config.read_text()))
    if args.execute:
        execute(config)
    else:
        print("DRY RUN: no commands executed; account/repository identity will be checked before mutation.")
        for cmd in planned_commands(config):
            print(shlex.join(cmd))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"Authentication bootstrap stopped: {error}. Inspect partial state before retrying.") from None
