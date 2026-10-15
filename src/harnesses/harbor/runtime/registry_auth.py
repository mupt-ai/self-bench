"""Scoped pull credentials shared by Harbor adapters; never task/container environment."""

from __future__ import annotations

import base64
import json
import os
import tempfile
from pathlib import Path


# Harbor builds the agent from the task's environment/ and a separate verifier from its tests/.
ROLES = {"environment": "agent", "tests": "verifier"}


def record_image(record_dir: str | None, environment_dir: Path, image: str | None) -> None:
    """Writes the provider image a role's sandbox started from, for the worker to export later."""
    role = ROLES.get(environment_dir.name)
    if not record_dir or not role or not image:
        return
    directory = Path(record_dir)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / role).write_text(image)


def registry_login() -> tuple[str, str, str] | None:
    host = os.environ.get("SELFBENCH_REGISTRY_HOST")
    password = os.environ.get("SELFBENCH_REGISTRY_PASSWORD")
    if not host or not password:
        return None
    return host, os.environ.get("SELFBENCH_REGISTRY_USERNAME", "selfbench"), password


async def stage_compose_login(upload) -> bool:
    """Only the trusted DinD host gets this file, never its task's mounted build context."""
    login = registry_login()
    if not login:
        return False
    host, username, password = login
    auth = base64.b64encode(f"{username}:{password}".encode()).decode()
    with tempfile.TemporaryDirectory(prefix="selfbench-pull-") as root:
        path = Path(root) / "config.json"
        path.write_text(json.dumps({"auths": {host: {"auth": auth}}}))
        path.chmod(0o600)
        await upload(path, "/root/.docker/config.json")
    return True
