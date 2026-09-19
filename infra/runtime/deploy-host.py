#!/usr/bin/env python3
"""Deploy selected Compose services on the VM; invoked by CI over IAP."""

import argparse
import base64
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request

from check_release import read_env, validate


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def metadata(path):
    request = urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/" + path,
        headers={"Metadata-Flavor": "Google"},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return response.read()


def rollout(compose, service, release, state):
    services = ["api", "worker"] if service == "all" else [service]
    command = compose + ["run", "--rm", "--no-deps", "-T", "--entrypoint", "node"]

    run(compose + ["pull", *services])
    for role in services:
        run(command + [role, "dist/deploy-main.js", "config"])
    run(command + [services[0], "dist/deploy-main.js", "migrate"])

    for role in services:
        run(compose + ["up", "-d", "--no-deps", "--wait", "--wait-timeout", "180", role])
        (state / f"current-{role}-release").write_text(str(release) + "\n")
    if service == "all":
        (state / "current-release").write_text(str(release) + "\n")


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release_env", type=Path)
    parser.add_argument("--project", required=True)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--service", choices=["api", "worker", "all"], default="all")
    for role in ("shared", "api", "worker"):
        parser.add_argument(f"--{role}-version", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}-[1-9][0-9]*-[1-9][0-9]*", args.release_id):
        parser.error("Invalid release directory")
    return args


def prepare_release(args, release, token):
    release.mkdir(parents=True, exist_ok=False)
    source = Path(__file__).resolve().parent
    (release / "compose.yaml").write_bytes((source / "compose.yaml").read_bytes())
    release_env = release / "release.env"
    release_env.write_bytes(args.release_env.read_bytes())
    coordinates = read_env(release_env)

    for role in ("shared", "api", "worker"):
        version = getattr(args, f"{role}_version")
        if not re.fullmatch("[1-9][0-9]*", version):
            raise ValueError("Pin numeric secret versions")
        destination = release / f"{role}.env"
        if coordinates[f"SELFBENCH_{role.upper()}_ENV_FILE"] != str(destination):
            raise ValueError("Secret paths must belong to this release")
        url = (
            f"https://secretmanager.googleapis.com/v1/projects/{args.project}"
            f"/secrets/selfbench-{role}-env/versions/{version}:access"
        )
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)["payload"]["data"]
        destination.write_bytes(base64.b64decode(payload, validate=True))

    return validate(coordinates["SELFBENCH_ENVIRONMENT"], args.project, release_env)


def main():
    args = arguments()
    if os.geteuid() != 0:
        raise ValueError("Run as root")
    os.umask(0o077)
    if metadata("project/project-id").decode() != args.project:
        raise ValueError("Wrong VM project")

    state = Path("/opt/selfbench")
    state.mkdir(exist_ok=True)
    with (state / "deploy.lock").open("w") as lock, tempfile.TemporaryDirectory() as authdir:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.environ["DOCKER_CONFIG"] = authdir
        token = json.loads(metadata("instance/service-accounts/default/token"))["access_token"]
        release = state / "releases" / args.release_id
        checked = prepare_release(args, release, token)
        run(
            [
                "docker",
                "login",
                "--username",
                "oauth2accesstoken",
                "--password-stdin",
                checked["registry"],
            ],
            input=token.encode(),
            stdout=subprocess.DEVNULL,
        )
        compose = [
            "docker",
            "compose",
            "--env-file",
            str(release / "release.env"),
            "-f",
            str(release / "compose.yaml"),
        ]
        rollout(compose, args.service, release, state)
    print(f"{args.service} deployment verified.")


if __name__ == "__main__":
    # CI redirects this process's output to a root-only deploy.log.
    main()
