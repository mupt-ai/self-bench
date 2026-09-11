"""Pure validation contracts for private Terraform plan promotion."""
import hashlib
import json
import re
import time

TERRAFORM_VERSION = "1.14.2"
MAX_PLAN_AGE_SECONDS = 24 * 60 * 60
ALLOWED_TYPES = {
    "google_project_service", "google_service_account", "google_project_iam_custom_role",
    "google_project_iam_member", "google_service_account_iam_member", "google_compute_network",
    "google_compute_subnetwork", "google_compute_firewall", "google_compute_address",
    "google_compute_global_address", "google_compute_instance", "google_iap_tunnel_instance_iam_member",
    "google_service_networking_connection", "google_storage_bucket", "google_storage_bucket_iam_member",
    "google_artifact_registry_repository", "google_artifact_registry_repository_iam_member",
    "google_secret_manager_secret", "google_secret_manager_secret_iam_member",
    "google_sql_database_instance", "google_sql_database",
}
INPUT_KEYS = {"project_id", "region", "zone", "boot_image", "machine_type", "enable_public_web",
              "create_cloud_sql", "cloud_sql_tier", "cloud_sql_availability_type",
              "cloud_sql_retained_backups", "operator_members"}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def context(env):
    result = {"environment": env.get("TF_ENVIRONMENT", ""), "project": env.get("GCP_PROJECT_ID", ""),
              "state_bucket": env.get("TF_STATE_BUCKET", ""), "plan_bucket": env.get("TF_PLAN_BUCKET", ""),
              "run_id": env.get("GITHUB_RUN_ID", ""), "run_attempt": env.get("GITHUB_RUN_ATTEMPT", ""),
              "source_sha": env.get("GITHUB_SHA", ""), "repository": env.get("GITHUB_REPOSITORY", "")}
    if result["environment"] not in ("dev", "prod"):
        raise ValueError("Unknown Terraform environment.")
    event, ref = env.get("GITHUB_EVENT_NAME"), env.get("GITHUB_REF", "")
    if env.get("RUNNER_ENVIRONMENT") != "github-hosted":
        raise ValueError("Privileged deployments require a GitHub-hosted runner.")
    if result["environment"] == "dev":
        if event not in ("push", "workflow_dispatch") or ref != f"refs/heads/{env.get('GITHUB_DEFAULT_BRANCH', '')}":
            raise ValueError("Dev deploys must run from the default branch.")
    elif (event != "release" or not ref.startswith("refs/tags/")
          or env.get("RELEASE_PRERELEASE") != "false" or env.get("RELEASE_DRAFT") != "false"):
        raise ValueError("Production requires a published stable release tag.")
    mode = env.get("INFRASTRUCTURE_ONLY", "false")
    if mode not in ("true", "false"):
        raise ValueError("Invalid infrastructure-only flag.")
    if mode == "true" and (result["environment"] != "dev" or event != "workflow_dispatch"):
        raise ValueError("Infrastructure-only bootstrap must be an explicit manual dev run.")
    result["infrastructure_only"] = mode == "true"
    for key in ("run_id", "run_attempt"):
        if not re.fullmatch(r"[1-9][0-9]*", result[key]):
            raise ValueError("Invalid workflow run identity.")
    if not re.fullmatch(r"[0-9a-f]{40}", result["source_sha"]):
        raise ValueError("Expected the exact source commit SHA.")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", result["repository"]):
        raise ValueError("Invalid repository identity.")
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", result["project"]):
        raise ValueError("Invalid project ID.")
    for key in ("state_bucket", "plan_bucket"):
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", result[key]):
            raise ValueError("Invalid private storage bucket.")
    if result["state_bucket"] == result["plan_bucket"]:
        raise ValueError("State and plans must be separate.")
    inputs = json.loads(env.get("TF_INPUTS_JSON", "{}"))
    required = {"project_id", "region", "zone", "boot_image", "operator_members"}
    if not isinstance(inputs, dict) or set(inputs) - INPUT_KEYS or not required <= set(inputs):
        raise ValueError("Configure only the supported nonsecret Terraform inputs.")
    if inputs["project_id"] != result["project"]:
        raise ValueError("Terraform input project differs from the authenticated environment.")
    result["inputs_sha256"] = digest(canonical(inputs))
    return result, inputs


def prefix(ctx):
    return f"terraform/{ctx['environment']}/{ctx['run_id']}/{ctx['run_attempt']}/{ctx['source_sha']}"


def object_uri(ctx, filename, generation=None):
    if filename not in ("terraform.tfplan", "plan.txt", "manifest.json", "diagnostics.txt", "apply.log", "deploy.log", "outputs.json"):
        raise ValueError("Unrecognized private artifact.")
    object_prefix = prefix(ctx)
    if filename in ("apply.log", "deploy.log", "outputs.json"):
        object_prefix = "apply-logs/" + object_prefix
    uri = f"gs://{ctx['plan_bucket']}/{object_prefix}/{filename}"
    if generation is not None:
        if not re.fullmatch(r"[1-9][0-9]*", str(generation)):
            raise ValueError("Invalid immutable object generation.")
        uri += f"#{generation}"
    return uri


def inspect_plan(plan, ctx):
    if (plan.get("terraform_version") != TERRAFORM_VERSION or not str(plan.get("format_version", "")).startswith("1.")
            or plan.get("errored") or plan.get("complete") is False or plan.get("deferred_changes")):
        raise ValueError("Unsupported, incomplete or errored Terraform plan.")
    changes = plan.get("resource_changes")
    if not isinstance(changes, list):
        raise ValueError("Plan resource changes are missing.")
    counts = {"create": 0, "update": 0, "delete": 0}
    sizing = {}
    for resource in changes:
        if resource.get("mode") == "data":
            continue
        if resource.get("mode") != "managed":
            raise ValueError("Unknown resource mode in saved plan.")
        kind = resource.get("type")
        if kind not in ALLOWED_TYPES or not resource.get("address", "").startswith("module.selfbench."):
            raise ValueError("Plan contains an unmanaged or unapproved resource type/address.")
        change = resource.get("change", {})
        actions = change.get("actions")
        if actions not in (["no-op"], ["create"], ["update"]):
            raise ValueError("Deletion, replacement or unsupported actions require separate operator review.")
        after = change.get("after") or {}
        if (after.get("project", ctx["project"]) != ctx["project"]
                or change.get("after_unknown", {}).get("project")):
            raise ValueError("Plan targets an unexpected or unknown project.")
        if actions[0] != "no-op":
            counts[actions[0]] += 1
        if kind == "google_compute_instance":
            sizing["vm"] = after.get("machine_type")
        if kind == "google_sql_database_instance":
            settings = after.get("settings", [{}])[0]
            sizing["database"] = {"tier": settings.get("tier"), "availability": settings.get("availability_type")}
    return {"counts": counts, "sizing": sizing, "has_changes": bool(counts["create"] + counts["update"])}


def manifest(ctx, plan_bytes, generation, lock_bytes, summary, now=None):
    object_uri(ctx, "terraform.tfplan", generation)
    return {"schema": 1, **ctx, "terraform_version": TERRAFORM_VERSION,
            "created_at": int(time.time() if now is None else now),
            "plan_sha256": digest(plan_bytes), "plan_generation": str(generation),
            "lock_sha256": digest(lock_bytes), "summary": summary}


def verify_manifest(record, ctx, lock_bytes, now=None):
    if record.get("schema") != 1 or record.get("terraform_version") != TERRAFORM_VERSION:
        raise ValueError("Unsupported saved plan manifest.")
    if any(record.get(key) != value for key, value in ctx.items()):
        raise ValueError("Saved plan belongs to different inputs, project, environment, source or workflow run.")
    created = record.get("created_at")
    age = int(time.time() if now is None else now) - created if isinstance(created, int) else -999
    if not 0 <= age <= MAX_PLAN_AGE_SECONDS:
        raise ValueError("Saved plan has expired or has an invalid timestamp; generate a new plan.")
    if record.get("lock_sha256") != digest(lock_bytes):
        raise ValueError("Provider lockfile differs from the reviewed plan.")
    if not re.fullmatch(r"[0-9a-f]{64}", record.get("plan_sha256", "")):
        raise ValueError("Saved plan hash is missing or malformed.")
    object_uri(ctx, "terraform.tfplan", record.get("plan_generation", ""))
