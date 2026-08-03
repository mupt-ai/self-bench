"""Harbor-backed task validation and rollout helpers."""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .harbor import (
    build_harbor_task,
    compatibility_result,
    run_harbor_task,
    validation_result,
)
from .result_schema import RESULT_SCHEMA_VERSION
from .task import Task

# Harbor's built-in Pi agent forwards credentials for openai, anthropic,
# openrouter, google, and several others automatically. Fireworks is not in
# that list, so selfbench forwards it explicitly via --agent-env.
_PROVIDER_ENV_KEYS: dict[str, str] = {
    "fireworks": "FIREWORKS_API_KEY",
}

# Default Harbor execution environments. Public selfbench validation runs on
# Modal so a large public task set can fan out without contending for a single
# Docker daemon; ``docker`` (and ``local`` where Harbor supports it) remain
# available as explicit overrides for offline/local debugging. Agent rollouts
# still default to Docker, unchanged, because they are run deliberately and
# in smaller batches.
DEFAULT_VALIDATION_ENVIRONMENT = "modal"
DEFAULT_ROLLOUT_ENVIRONMENT = "docker"


def validate_task(
    task: Task,
    local_repo: Path,
    *,
    harbor_root: Path = Path("harbor-tasks"),
    jobs_root: Path = Path("harbor-jobs"),
    environment: str = DEFAULT_VALIDATION_ENVIRONMENT,
    rebuild: bool = False,
    verbose: bool = True,
    log_path: Path | None = None,
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
        log_path=log_path,
    )
    oracle = run_harbor_task(
        harbor_task,
        jobs_root,
        agent="oracle",
        environment=environment,
        quiet=not verbose,
        log_path=log_path,
    )
    return validation_result(task, base, oracle)


def is_currently_valid(task: Task, results_root: Path) -> bool:
    """True when an existing validation result is valid and not stale."""
    path = results_root / task.task_id / "validation" / "result.json"
    if not path.is_file():
        return False
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError:
        return False
    if data.get("result_schema_version") != RESULT_SCHEMA_VERSION:
        return False
    if data.get("task_fingerprints") != task.evaluation_fingerprints:
        return False
    return bool(data.get("valid"))


@dataclass
class BatchValidationOutcome:
    """Per-task outcome for a batch validation run."""

    task_id: str
    status: str  # "skipped", "valid", "invalid", "error"
    exit_code: int = 0
    error: str | None = None
    result_path: Path | None = None

    def as_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "task_id": self.task_id,
            "status": self.status,
            "exit_code": self.exit_code,
        }
        if self.error is not None:
            data["error"] = self.error
        if self.result_path is not None:
            data["result_path"] = str(self.result_path)
        return data


def validate_batch(
    tasks: list[Task],
    repo_resolver,
    *,
    results_root: Path,
    harbor_root: Path = Path("harbor-tasks"),
    jobs_root: Path = Path("harbor-jobs"),
    environment: str = DEFAULT_VALIDATION_ENVIRONMENT,
    concurrency: int | None = None,
    rebuild: bool = True,
    log_dir: Path | None = None,
) -> list[BatchValidationOutcome]:
    """Validate many tasks concurrently, preserving per-task results and logs.

    ``repo_resolver`` maps a task to the local repository path that contains
    ``base_commit``. It is a callable ``(task: Task) -> Path`` so callers keep
    control of the task-to-repo mapping (an operational concern, not a
    selfbench one).

    The default ``environment`` is Modal so the whole public set can fan out
    without contending for a single local Docker daemon; pass ``docker`` (or
    any Harbor environment) to debug locally. Modal authentication and
    per-task errors are surfaced, never hidden.

    ``concurrency`` defaults to ``len(tasks)`` so every task runs at once on
    Modal; pass a smaller number to throttle. Idempotent: tasks that already
    have a current, valid result are skipped.
    """
    import concurrent.futures as cf

    if concurrency is None:
        concurrency = max(1, len(tasks))
    else:
        concurrency = max(1, int(concurrency))
    if log_dir is not None:
        log_dir.mkdir(parents=True, exist_ok=True)

    outcomes: list[BatchValidationOutcome] = []

    def _log(log_file: Path | None, message: str) -> None:
        if log_file is None:
            return
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with log_file.open("a") as handle:
            handle.write(message + "\n")

    def _one(task: Task) -> BatchValidationOutcome:
        log_file = (log_dir / f"{task.task_id}.log") if log_dir is not None else None
        _log(log_file, f"=== validate {task.task_id} start env={environment} {datetime.now(UTC).isoformat()} ===")
        if is_currently_valid(task, results_root):
            _log(log_file, f"=== validate {task.task_id} skipped (already valid) ===")
            return BatchValidationOutcome(
                task_id=task.task_id,
                status="skipped",
                result_path=results_root / task.task_id / "validation" / "result.json",
            )
        try:
            result = validate_task(
                task,
                repo_resolver(task),
                harbor_root=harbor_root,
                jobs_root=jobs_root,
                environment=environment,
                rebuild=rebuild,
                verbose=False,
                log_path=log_file,
            )
            path = save_result(result, results_root, "validation")
            status = "valid" if result.get("valid") else "invalid"
            _log(log_file, f"=== validate {task.task_id} {status} ===")
            return BatchValidationOutcome(
                task_id=task.task_id,
                status=status,
                exit_code=0 if result.get("valid") else 1,
                result_path=path,
            )
        except Exception as exc:  # noqa: BLE001 - surface in the outcome, do not hide
            _log(log_file, f"=== validate {task.task_id} ERROR: {type(exc).__name__}: {exc} ===")
            return BatchValidationOutcome(
                task_id=task.task_id,
                status="error",
                exit_code=2,
                error=f"{type(exc).__name__}: {exc}",
            )

    with cf.ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {pool.submit(_one, task): task for task in tasks}
        for future in cf.as_completed(futures):
            outcomes.append(future.result())

    outcomes.sort(key=lambda o: o.task_id)
    return outcomes


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
    environment: str = DEFAULT_ROLLOUT_ENVIRONMENT,
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
