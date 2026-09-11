#!/usr/bin/env python3
"""Local-only preflight. Never executes a release or prints secret values."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
from urllib.parse import parse_qs, urlsplit


def read_env(path, private=False):
    path = Path(path)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise ValueError("Env-files must be absolute paths to regular, non-symlink files.")
    info = path.stat()
    if private and (stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.geteuid()):
        raise ValueError("Secret env-files must be owned by the caller with mode 0600.")
    result = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or key in result:
            raise ValueError("Invalid or duplicate env-file entry.")
        if not value or value.startswith(('"', "'")) or "\x00" in value:
            raise ValueError(f"Use nonempty, unquoted Docker env-file values for {key}.")
        if any(marker in value for marker in ("YOUR-", "LOAD-", "REVIEWED-", "SCOPED-", "PRIVATE-DB")):
            raise ValueError(f"Replace the placeholder for {key} before release.")
        result[key] = value
    return result


def validate(environment, project, release_path):
    if environment not in ("dev", "prod") or not re.fullmatch(
            rf"selfbench-{environment}-[a-z0-9-]+[a-z0-9]", project):
        raise ValueError("Project must belong to the requested SelfBench environment.")
    release = read_env(release_path)
    release_keys = {"SELFBENCH_ENVIRONMENT", "SELFBENCH_IMAGE", "SELFBENCH_SHARED_ENV_FILE",
                    "SELFBENCH_API_ENV_FILE", "SELFBENCH_WORKER_ENV_FILE"}
    if set(release) != release_keys or release["SELFBENCH_ENVIRONMENT"] != environment:
        raise ValueError("Release coordinate keys/environment do not match.")
    match = re.fullmatch(
        rf"([a-z]+-[a-z]+[0-9])-docker\.pkg\.dev/{re.escape(project)}/selfbench/selfbench@sha256:[0-9a-f]{{64}}",
        release["SELFBENCH_IMAGE"])
    if not match:
        raise ValueError("Use an immutable image digest in this environment's Artifact Registry.")
    shared = read_env(release["SELFBENCH_SHARED_ENV_FILE"], private=True)
    api = read_env(release["SELFBENCH_API_ENV_FILE"], private=True)
    worker = read_env(release["SELFBENCH_WORKER_ENV_FILE"], private=True)
    expected = {
        "SELFBENCH_API_HOST": "0.0.0.0", "SELFBENCH_API_PORT": "8080",
        "SELFBENCH_ARTIFACT_BACKEND": "gcs", "SELFBENCH_GCS_BUCKET": f"{project}-artifacts",
        "SELFBENCH_GCS_PREFIX": "selfbench", "SELFBENCH_TEMPORAL_TLS": "true",
        "SELFBENCH_TASK_QUEUE": f"selfbench-{environment}",
        "SELFBENCH_EVAL_TASK_QUEUE": f"selfbench-{environment}",
        "SELFBENCH_EXECUTION_BACKEND": "modal", "SELFBENCH_HARBOR_ENVIRONMENT": "modal",
    }
    required_shared = set(expected) | {"SELFBENCH_DATABASE_URL", "SELFBENCH_EVAL_CREDENTIAL_KEY",
        "SELFBENCH_TEMPORAL_ADDRESS", "SELFBENCH_TEMPORAL_NAMESPACE", "SELFBENCH_TEMPORAL_API_KEY",
        "SELFBENCH_ACTIVITY_CONCURRENCY"}
    required_api = {"SELFBENCH_API_TOKEN", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET",
                    "SELFBENCH_SESSION_SECRET", "SELFBENCH_PUBLIC_URL"}
    required_worker = {"SELFBENCH_API_TOKEN", "GH_TOKEN", "OPENAI_API_KEY",
                       "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"}
    for data, keys in ((shared, required_shared), (api, required_api), (worker, required_worker)):
        if set(data) != keys:
            raise ValueError("Env-file keys differ from this initial Modal deployment contract.")
    for key, value in expected.items():
        if shared[key] != value:
            raise ValueError(f"Environment mismatch for {key}.")
    if not re.fullmatch(r"[0-9a-f]{64}", shared["SELFBENCH_EVAL_CREDENTIAL_KEY"]):
        raise ValueError("Evaluation encryption key must be 32 bytes encoded as lowercase hex.")
    if (not re.fullmatch(rf"selfbench-{environment}(?:\.[a-z0-9-]+)?", shared["SELFBENCH_TEMPORAL_NAMESPACE"])
            or not shared["SELFBENCH_TEMPORAL_ADDRESS"].endswith(":7233")):
        raise ValueError("Choose this environment's Temporal namespace and gRPC endpoint on port 7233.")
    if shared["SELFBENCH_ACTIVITY_CONCURRENCY"] != "1":
        raise ValueError("Initial deployment concurrency is one; raise only after measured validation.")
    origin = urlsplit(api["SELFBENCH_PUBLIC_URL"])
    if (origin.scheme != "https" or not origin.hostname or origin.username or origin.password
            or origin.path not in ("", "/") or origin.query or origin.fragment):
        raise ValueError("Production-shaped deployments require an HTTPS public origin.")
    if min(len(api["SELFBENCH_SESSION_SECRET"]), len(api["SELFBENCH_API_TOKEN"]),
           len(worker["SELFBENCH_API_TOKEN"])) < 32:
        raise ValueError("Session/API/worker tokens must each be at least 32 characters.")
    if api["SELFBENCH_API_TOKEN"] == worker["SELFBENCH_API_TOKEN"]:
        raise ValueError("Do not give the worker the API bearer credential.")
    database = urlsplit(shared["SELFBENCH_DATABASE_URL"])
    if (database.scheme not in ("postgres", "postgresql") or not database.hostname
            or parse_qs(database.query).get("sslmode") not in (["require"], ["verify-ca"], ["verify-full"])):
        raise ValueError("The initial DB connection must explicitly require TLS.")
    return {"environment": environment, "project": project,
            "image": release["SELFBENCH_IMAGE"], "registry": f"{match[1]}-docker.pkg.dev"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", choices=["dev", "prod"], required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--release-env", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(validate(args.environment, args.project, args.release_env)))
    except (ValueError, OSError) as error:
        raise SystemExit(f"Preflight failed: {error}") from None


if __name__ == "__main__":
    main()
