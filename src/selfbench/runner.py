"""Harbor-backed task validation helpers."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .harbor import (
    build_harbor_task,
    run_harbor_task,
    validation_result,
)
from .result_schema import RESULT_SCHEMA_VERSION
from .task import Task

# Public validation defaults to Modal so larger task sets can fan out. Docker
# remains available as an explicit local/offline override.
DEFAULT_VALIDATION_ENVIRONMENT = "modal"
DEFAULT_SETUP_FAILURE_THRESHOLD = 2

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
    result = validation_result(task, base, oracle)
    result["harbor"]["task_dir"] = str(harbor_task.resolve())
    return result


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
    status: str  # "skipped", "valid", "invalid", "error", or "blocked"
    exit_code: int = 0
    error: str | None = None
    result_path: Path | None = None
    setup_failure_signature: str | None = None

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
        if self.setup_failure_signature is not None:
            data["setup_failure_signature"] = self.setup_failure_signature
        return data


def preflight_harbor_task(harbor_task: Path, *, log_path: Path | None = None) -> None:
    """Build both generated images locally before spending a remote validation.

    The build executes the task's real ``setup_cmd``. It is deliberately not a
    replacement for Harbor validation: it only catches dependency, toolchain,
    and Dockerfile failures before a Modal batch fans them out.
    """
    docker = shutil.which("docker")
    if docker is None:
        raise RuntimeError("Docker is required for validation preflight; pass --no-preflight to skip it")
    for name in ("environment", "tests"):
        context = harbor_task / name
        command = [docker, "build", "--progress=plain", "--file", str(context / "Dockerfile"), str(context)]
        result = subprocess.run(command, text=True, capture_output=True, check=False)
        output = result.stdout + result.stderr
        if log_path is not None:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with log_path.open("a") as log:
                log.write(f"=== preflight {name} image ===\n")
                log.write(output)
                if output and not output.endswith("\n"):
                    log.write("\n")
        if result.returncode != 0:
            detail = _preflight_failure_detail(output)
            raise RuntimeError(f"Docker preflight failed for {name} image: {detail}")


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
    preflight: bool = False,
    setup_failure_threshold: int = DEFAULT_SETUP_FAILURE_THRESHOLD,
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

    When ``preflight`` is enabled, each local validation builds both generated
    images. Modal batches preflight only their two canaries per repository;
    two identical setup failures block the remaining queued
    tasks for that repository rather than spending the whole batch on one
    broken environment.
    """
    import concurrent.futures as cf
    from collections import Counter, deque

    if concurrency is None:
        concurrency = max(1, len(tasks))
    else:
        concurrency = max(1, int(concurrency))
    if setup_failure_threshold < 1:
        raise ValueError("setup_failure_threshold must be positive")
    if log_dir is not None:
        log_dir.mkdir(parents=True, exist_ok=True)

    outcomes: list[BatchValidationOutcome] = []
    preflight_lock = threading.Lock()

    def _log(log_file: Path | None, message: str) -> None:
        if log_file is None:
            return
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with log_file.open("a") as handle:
            handle.write(message + "\n")

    def _one(task: Task, *, should_preflight: bool) -> BatchValidationOutcome:
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
            local_repo = repo_resolver(task)
            if should_preflight:
                harbor_task = build_harbor_task(
                    task,
                    local_repo,
                    harbor_root,
                    overwrite=rebuild,
                )
                # Docker builds are memory-heavy, especially for monorepos. Keep
                # this local guard serial even when the subsequent Modal trials fan out.
                with preflight_lock:
                    preflight_harbor_task(harbor_task, log_path=log_file)
            result = validate_task(
                task,
                local_repo,
                harbor_root=harbor_root,
                jobs_root=jobs_root,
                environment=environment,
                rebuild=False if should_preflight else rebuild,
                verbose=False,
                log_path=log_file,
            )
            path = save_result(result, results_root, "validation")
            status = "valid" if result.get("valid") else "invalid"
            signature = _result_setup_failure_signature(result)
            _log(log_file, f"=== validate {task.task_id} {status} ===")
            return BatchValidationOutcome(
                task_id=task.task_id,
                status=status,
                exit_code=0 if result.get("valid") else 1,
                result_path=path,
                setup_failure_signature=signature,
            )
        except Exception as exc:  # noqa: BLE001 - surface in the outcome, do not hide
            error = f"{type(exc).__name__}: {exc}"
            signature = _error_setup_failure_signature(error)
            _log(log_file, f"=== validate {task.task_id} ERROR: {error} ===")
            return BatchValidationOutcome(
                task_id=task.task_id,
                status="error",
                exit_code=2,
                error=error,
                setup_failure_signature=signature,
            )

    if environment != "modal":
        with cf.ThreadPoolExecutor(max_workers=concurrency) as pool:
            futures = [pool.submit(_one, task, should_preflight=preflight) for task in tasks]
            for future in cf.as_completed(futures):
                outcomes.append(future.result())
        outcomes.sort(key=lambda o: o.task_id)
        return outcomes

    by_repo: dict[str, deque[Task]] = {}
    for task in tasks:
        by_repo.setdefault(task.repo, deque()).append(task)
    canary_queue: deque[tuple[str, Task]] = deque()
    remaining: dict[str, deque[Task]] = {}
    canaries_planned: dict[str, int] = {}
    canary_task_ids: dict[str, set[str]] = {}
    canaries_finished: Counter[str] = Counter()
    canary_outcomes: dict[str, list[BatchValidationOutcome]] = {}
    for repo, queued in by_repo.items():
        count = min(setup_failure_threshold, len(queued))
        canaries_planned[repo] = count
        canary_task_ids[repo] = set()
        for _ in range(count):
            task = queued.popleft()
            canary_task_ids[repo].add(task.task_id)
            canary_queue.append((repo, task))
        remaining[repo] = queued

    regular_queue: deque[tuple[str, Task]] = deque()
    with cf.ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures: dict[cf.Future[BatchValidationOutcome], tuple[str, bool]] = {}
        while canary_queue or regular_queue or futures:
            while len(futures) < concurrency and (canary_queue or regular_queue):
                repo, task = canary_queue.popleft() if canary_queue else regular_queue.popleft()
                is_canary = task.task_id in canary_task_ids[repo]
                futures[pool.submit(_one, task, should_preflight=preflight and is_canary)] = (repo, is_canary)
            if not futures:
                continue
            finished, _ = cf.wait(futures, return_when=cf.FIRST_COMPLETED)
            for future in finished:
                repo, is_canary = futures.pop(future)
                outcome = future.result()
                outcomes.append(outcome)
                if not is_canary:
                    continue
                canaries_finished[repo] += 1
                canary_outcomes.setdefault(repo, []).append(outcome)
                if canaries_finished[repo] != canaries_planned[repo]:
                    continue
                signatures = Counter(
                    item.setup_failure_signature
                    for item in canary_outcomes[repo]
                    if item.setup_failure_signature is not None
                )
                repeated = next(
                    (signature for signature, count in signatures.items() if count >= setup_failure_threshold),
                    None,
                )
                if repeated is None:
                    regular_queue.extend((repo, task) for task in remaining[repo])
                    remaining[repo].clear()
                    continue
                message = f"batch circuit breaker: repeated setup failure {repeated}"
                while remaining[repo]:
                    task = remaining[repo].popleft()
                    log_file = (log_dir / f"{task.task_id}.log") if log_dir is not None else None
                    _log(log_file, f"=== validate {task.task_id} BLOCKED: {message} ===")
                    outcomes.append(
                        BatchValidationOutcome(
                            task_id=task.task_id,
                            status="blocked",
                            exit_code=2,
                            error=message,
                            setup_failure_signature=repeated,
                        )
                    )

    outcomes.sort(key=lambda o: o.task_id)
    return outcomes


def _result_setup_failure_signature(result: dict[str, Any]) -> str | None:
    failures = result.get("setup_failures")
    if isinstance(failures, dict):
        values = [value for value in failures.values() if isinstance(value, str) and value]
        if values:
            return sorted(values)[0]
    infrastructure = result.get("infrastructure_errors")
    if isinstance(infrastructure, dict):
        values = [value for value in infrastructure.values() if isinstance(value, str) and value]
        if values:
            return _error_setup_failure_signature(sorted(values)[0])
    return None


def _preflight_failure_detail(output: str) -> str:
    if match := re.search(r"\bERR_[A-Z0-9_]+\b", output):
        return match.group(0)
    lines = output.strip().splitlines()
    return lines[-1] if lines else "no Docker output"


def _error_setup_failure_signature(error: str) -> str | None:
    if match := re.search(r"\bERR_[A-Z0-9_]+\b", error):
        return match.group(0)
    if "Docker preflight failed" in error:
        return "Docker preflight failed"
    if "Docker is required for validation preflight" in error:
        return "Docker preflight unavailable"
    if "Image build" in error:
        return "image build failed"
    if "RemoteError" in error:
        return "RemoteError"
    return None


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
