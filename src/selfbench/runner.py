"""Harbor-backed task validation and rollout helpers."""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

from .harbor import (
    build_harbor_task,
    compatibility_result,
    run_harbor_task,
    validation_result,
)
from .task import Task

# Harbor's built-in Pi agent forwards credentials for openai, anthropic,
# openrouter, google, and several others automatically. Fireworks is not in
# that list, so selfbench forwards it explicitly via --agent-env.
_PROVIDER_ENV_KEYS: dict[str, str] = {
    "fireworks": "FIREWORKS_API_KEY",
}


def validate_task(
    task: Task,
    local_repo: Path,
    *,
    harbor_root: Path = Path("harbor-tasks"),
    jobs_root: Path = Path("harbor-jobs"),
    environment: str = "docker",
    rebuild: bool = False,
    verbose: bool = True,
) -> dict:
    """Validate base failure and oracle success as canonical Harbor trials."""
    harbor_task = build_harbor_task(
        task,
        local_repo,
        harbor_root,
        overwrite=rebuild,
    )
    base = run_harbor_task(
        harbor_task,
        jobs_root,
        agent="nop",
        environment=environment,
        quiet=not verbose,
    )
    oracle = run_harbor_task(
        harbor_task,
        jobs_root,
        agent="oracle",
        environment=environment,
        quiet=not verbose,
    )
    return validation_result(task, base, oracle)


def run_task(
    task: Task,
    local_repo: Path,
    provider: str,
    model: str,
    thinking: str | None = None,
    *,
    agent: str = "pi",
    harbor_root: Path = Path("harbor-tasks"),
    jobs_root: Path = Path("harbor-jobs"),
    environment: str = "docker",
    rebuild: bool = False,
    verbose: bool = True,
) -> dict:
    """Run an agent with Harbor and create a lightweight local result index."""
    harbor_task = build_harbor_task(
        task,
        local_repo,
        harbor_root,
        overwrite=rebuild,
    )
    model_name = f"{provider}/{model}"
    kwargs = {"thinking": thinking} if thinking else None
    agent_env: dict[str, str] = {}
    env_key = _PROVIDER_ENV_KEYS.get(provider)
    if env_key and os.environ.get(env_key):
        agent_env[env_key] = os.environ[env_key]
    run = run_harbor_task(
        harbor_task,
        jobs_root,
        agent=agent,
        model=model_name,
        environment=environment,
        agent_kwargs=kwargs,
        agent_env=agent_env or None,
        quiet=not verbose,
    )
    result = compatibility_result(task, run, run_kind="rollout")
    result.update({"provider": provider, "model": model, "thinking": thinking})
    return result


def save_result(result: dict, results_root: Path, subdir: str) -> Path:
    """Atomically index a Harbor result while preserving immutable history."""
    task_id = result.get("task_id")
    for label, value in (("task_id", task_id), ("result subdir", subdir)):
        if not isinstance(value, str) or not value or Path(value).name != value:
            raise ValueError(f"{label} must be a non-empty path-safe string")

    run_id = result.get("run_id")
    if not isinstance(run_id, str) or not run_id or Path(run_id).name != run_id:
        raise ValueError("result run_id must be a non-empty path-safe string")

    out = results_root / task_id / subdir
    run_dir = out / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    serialized = json.dumps(result, indent=2) + "\n"
    _atomic_write(run_dir / "result.json", serialized)
    if "agent_patch" in result:
        patch = str(result["agent_patch"])
        _atomic_write(run_dir / "agent.patch", patch)
        _atomic_write(out / "agent.patch", patch)
    _atomic_write(out / "result.json", serialized)
    return out / "result.json"


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(content)
    temporary.replace(path)
