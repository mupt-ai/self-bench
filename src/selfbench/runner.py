"""Harbor-backed task validation helpers."""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from .harbor import (
    build_harbor_task,
    run_harbor_task,
    validation_result,
)
from .task import Task


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
    result = validation_result(task, base, oracle)
    result["harbor"]["task_dir"] = str(harbor_task.resolve())
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
