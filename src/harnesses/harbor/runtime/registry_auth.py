"""Scoped pull credentials shared by Harbor adapters; never task/container environment."""

from __future__ import annotations

import base64
import json
import os
import tempfile
from pathlib import Path


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
