"""Runtime entrypoint for one SelfBench generation subagent in a Modal Sandbox."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

from .harbor import GENERATED_MANIFEST, build_harbor_task
from .modal_generation import (
    GenerationManifest,
    ManifestError,
    WorkerSpec,
    build_worker_request,
    load_generation_manifest,
    write_worker_artifact_manifest,
)
from .task import Task, load_task

WORK_ROOT = Path("/work")
ARTIFACT_ROOT = Path("/artifacts")


class CandidateRejected(ManifestError):
    """The assigned candidate did not produce one publishable task."""


class ProvenanceIntegrityError(RuntimeError):
    """A staged provenance file is missing, escaped its mount, or changed."""


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    os.replace(temporary, path)


def _run_logged(
    command: list[str],
    *,
    cwd: Path,
    stdout,
    stderr,
) -> None:
    subprocess.run(
        command,
        cwd=cwd,
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=stdout,
        stderr=stderr,
    )


def _clone_source(
    manifest: GenerationManifest,
    worker: WorkerSpec,
    repo_dir: Path,
    *,
    stdout,
    stderr,
) -> None:
    if os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN"):
        _run_logged(
            ["gh", "auth", "setup-git"],
            cwd=repo_dir.parent,
            stdout=stdout,
            stderr=stderr,
        )
    _run_logged(
        [
            "git",
            "clone",
            "--no-checkout",
            "--filter=blob:none",
            manifest.source_repo_url,
            str(repo_dir),
        ],
        cwd=repo_dir.parent,
        stdout=stdout,
        stderr=stderr,
    )
    commits = [manifest.source_commit]
    if worker.base_commit is not None:
        commits.append(worker.base_commit)
    if worker.completed_commit is not None:
        commits.append(worker.completed_commit)
    for commit in dict.fromkeys(commits):
        _run_logged(
            ["git", "fetch", "origin", commit],
            cwd=repo_dir,
            stdout=stdout,
            stderr=stderr,
        )
    _run_logged(
        ["git", "checkout", "--detach", manifest.source_commit],
        cwd=repo_dir,
        stdout=stdout,
        stderr=stderr,
    )
    actual_commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_dir,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if actual_commit != manifest.source_commit:
        raise RuntimeError(
            f"source checkout mismatch: expected {manifest.source_commit}, got {actual_commit}"
        )


def _compile_task_environments(
    tasks_root: Path,
    repo_dir: Path,
    output_path: Path,
    stdout_path: Path,
    stderr_path: Path,
) -> None:
    """Compile every task through the production Harbor setup contract.

    This resolves package-manager and lockfile evidence from the exact base
    snapshot and rejects conflicting/mutable setup declarations. The later
    centralized validation still executes both images and the nop/oracle tests.
    """
    compiled_root = output_path.parent / "compiled-environments"
    rows: list[dict[str, object]] = []
    with stdout_path.open("ab") as stdout, stderr_path.open("ab") as stderr:
        for task_dir in sorted(tasks_root.iterdir()):
            if not task_dir.is_dir() or not (task_dir / "task.json").is_file():
                continue
            try:
                task = load_task(task_dir)
                harbor_task = build_harbor_task(task, repo_dir, compiled_root)
                generated = json.loads((harbor_task / GENERATED_MANIFEST).read_text())
                setup_duration = _execute_setup_smoke(
                    task,
                    generated.get("package_manager_profile"),
                    repo_dir,
                    output_path.parent / "setup-worktrees" / task.task_id,
                    stdout=stdout,
                    stderr=stderr,
                )
            except (OSError, ValueError, subprocess.CalledProcessError) as exc:
                raise CandidateRejected(
                    f"task {task_dir.name} failed environment setup preflight: {exc}"
                ) from exc
            rows.append(
                {
                    "task_id": task.task_id,
                    "base_commit": task.base_commit,
                    "setup_cmd": task.setup_cmd,
                    "setup_executed": True,
                    "setup_duration_s": setup_duration,
                    "workdir": task.workdir,
                    "toolchains": task.toolchains,
                    "package_manager_profile": generated.get("package_manager_profile"),
                    "environment_compiler_revision": generated.get(
                        "environment_compiler_revision"
                    ),
                }
            )
    _write_json(output_path, {"status": "executed", "tasks": rows})


def _execute_setup_smoke(
    task: Task,
    package_profile: object,
    repo_dir: Path,
    checkout: Path,
    *,
    stdout,
    stderr,
) -> float:
    if checkout.exists():
        shutil.rmtree(checkout)
    checkout.parent.mkdir(parents=True, exist_ok=True)
    _run_logged(
        ["git", "worktree", "add", "--force", "--detach", str(checkout), task.base_commit],
        cwd=repo_dir,
        stdout=stdout,
        stderr=stderr,
    )
    try:
        _activate_package_manager(package_profile, checkout, stdout=stdout, stderr=stderr)
        started = time.monotonic()
        try:
            result = subprocess.run(
                ["bash", "-lc", task.setup_cmd],
                cwd=checkout / task.workdir,
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                timeout=task.timeout_setup,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise CandidateRejected(
                f"setup command timed out after {task.timeout_setup}s"
            ) from exc
        duration = round(time.monotonic() - started, 3)
        if result.returncode != 0:
            raise CandidateRejected(f"setup command exited {result.returncode}")
        return duration
    finally:
        subprocess.run(
            ["git", "worktree", "remove", "--force", str(checkout)],
            cwd=repo_dir,
            stdout=stdout,
            stderr=stderr,
            check=False,
        )
        if checkout.exists():
            shutil.rmtree(checkout)


def _activate_package_manager(
    package_profile: object,
    cwd: Path,
    *,
    stdout,
    stderr,
) -> None:
    if package_profile is None:
        return
    if not isinstance(package_profile, dict):
        raise CandidateRejected("compiled package-manager profile is invalid")
    manager = package_profile.get("manager")
    version = package_profile.get("version")
    specifier = package_profile.get("specifier")
    if not all(isinstance(value, str) and value for value in (manager, version, specifier)):
        raise CandidateRejected("compiled package-manager profile is incomplete")
    if manager in {"pnpm", "yarn"}:
        commands = [
            ["corepack", "enable"],
            ["corepack", "install", "--global", specifier],
        ]
    elif manager in {"npm", "bun"}:
        commands = [["npm", "install", "--global", specifier]]
    else:
        raise CandidateRejected(f"unsupported package manager in compiled profile: {manager}")
    for command in commands:
        _run_logged(command, cwd=cwd, stdout=stdout, stderr=stderr)
    actual = subprocess.run(
        [manager, "--version"],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if actual != version:
        raise CandidateRejected(
            f"activated {manager} version {actual!r}, expected {version!r}"
        )


def _run_create(
    manifest: GenerationManifest,
    worker: WorkerSpec,
    repo_dir: Path,
    tasks_root: Path,
    *,
    stdout,
    stderr,
) -> None:
    command = [
        "selfbench",
        "create",
        "--repo",
        str(repo_dir),
        "--tasks-root",
        str(tasks_root),
        "--count",
        str(worker.target_count),
        "--profile",
        manifest.agent.profile,
        "--provider",
        manifest.agent.provider,
        "--model",
        manifest.agent.model,
        "--print",
    ]
    if manifest.agent.thinking:
        command.extend(("--thinking", manifest.agent.thinking))
    command.append(build_worker_request(manifest, worker))
    _run_logged(command, cwd=repo_dir, stdout=stdout, stderr=stderr)


def _verify_provenance(worker: WorkerSpec, artifact_root: Path = ARTIFACT_ROOT) -> None:
    provenance = worker.provenance
    if provenance is None or provenance.get("kind") != "file":
        return
    path = Path(str(provenance.get("path", ""))).resolve()
    if not path.is_relative_to(artifact_root.resolve()) or not path.is_file():
        raise ProvenanceIntegrityError("staged provenance is outside the artifact mount or missing")
    expected = provenance.get("sha256")
    if not isinstance(expected, str):
        raise ProvenanceIntegrityError("staged provenance has no SHA-256 digest")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise ProvenanceIntegrityError("staged provenance SHA-256 does not match")


def run_worker(manifest: GenerationManifest, worker: WorkerSpec) -> dict[str, object]:
    build_commit = os.environ.get("SELFBENCH_BUILD_COMMIT") or "unknown"
    run_root = ARTIFACT_ROOT / "runs" / manifest.run_id
    final_root = run_root / "workers" / worker.worker_id
    status_path = run_root / "statuses" / f"{worker.worker_id}.json"
    failure_root = run_root / "failures" / worker.worker_id
    expected_fingerprint = manifest.worker_fingerprint(worker)
    if (final_root / "_SUCCESS").is_file():
        if (final_root / "_SUCCESS").read_text().strip() != expected_fingerprint:
            raise ManifestError(
                f"run {manifest.run_id} already has incompatible artifacts for {worker.worker_id}"
            )
        return {"worker_id": worker.worker_id, "status": "skipped", "tasks": worker.target_count}

    work_dir = WORK_ROOT / manifest.run_id / worker.worker_id
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True)
    repo_dir = work_dir / "repo"
    tasks_root = work_dir / "tasks"
    stdout_path = work_dir / "stdout.log"
    stderr_path = work_dir / "stderr.log"
    request = build_worker_request(manifest, worker)
    request_record = {
        "run_id": manifest.run_id,
        "run_fingerprint": manifest.fingerprint,
        "worker": worker.as_dict(),
        "source": {
            "repo_url": manifest.source_repo_url,
            "commit": manifest.source_commit,
        },
        "agent": manifest.agent.as_dict(),
        "request": request,
        "selfbench_commit": build_commit,
    }
    started_at = _utc_now()
    _write_json(
        status_path,
        {
            "worker_id": worker.worker_id,
            "status": "running",
            "started_at": started_at,
            "worker_fingerprint": expected_fingerprint,
        },
    )

    try:
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            _verify_provenance(worker)
            _clone_source(manifest, worker, repo_dir, stdout=stdout, stderr=stderr)
            _run_create(
                manifest,
                worker,
                repo_dir,
                tasks_root,
                stdout=stdout,
                stderr=stderr,
            )
        authored_tasks = [
            path
            for path in tasks_root.iterdir()
            if path.is_dir() and (path / "task.json").is_file()
        ] if tasks_root.is_dir() else []
        if not authored_tasks:
            raise CandidateRejected("assigned candidate produced no publishable task directory")
        _compile_task_environments(
            tasks_root,
            repo_dir,
            work_dir / "setup-preflight.json",
            stdout_path,
            stderr_path,
        )

        staging_root = run_root / ".staging" / f"{worker.worker_id}-{os.getpid()}"
        if staging_root.exists():
            shutil.rmtree(staging_root)
        staging_root.mkdir(parents=True)
        shutil.copytree(tasks_root, staging_root / "tasks")
        shutil.copy2(stdout_path, staging_root / "stdout.log")
        shutil.copy2(stderr_path, staging_root / "stderr.log")
        shutil.copy2(work_dir / "setup-preflight.json", staging_root / "setup-preflight.json")
        _write_json(staging_root / "request.json", request_record)
        write_worker_artifact_manifest(
            staging_root,
            staging_root / "tasks",
            manifest,
            worker,
            build_commit=build_commit,
        )
        (staging_root / "_SUCCESS").write_text(expected_fingerprint + "\n")
        final_root.parent.mkdir(parents=True, exist_ok=True)
        os.replace(staging_root, final_root)
        if failure_root.exists():
            shutil.rmtree(failure_root)
        _write_json(
            status_path,
            {
                "worker_id": worker.worker_id,
                "status": "complete",
                "started_at": started_at,
                "completed_at": _utc_now(),
                "worker_fingerprint": expected_fingerprint,
                "tasks": worker.target_count,
            },
        )
        return {"worker_id": worker.worker_id, "status": "complete", "tasks": worker.target_count}
    except Exception as exc:  # noqa: BLE001 - persist every sandbox failure before exit
        status = "rejected" if isinstance(exc, ManifestError) else "failed"
        failure_root.mkdir(parents=True, exist_ok=True)
        for path in (stdout_path, stderr_path):
            if path.is_file():
                shutil.copy2(path, failure_root / path.name)
        if tasks_root.is_dir():
            rejected_tasks = failure_root / "tasks"
            if rejected_tasks.exists():
                shutil.rmtree(rejected_tasks)
            shutil.copytree(tasks_root, rejected_tasks)
        _write_json(failure_root / "request.json", request_record)
        _write_json(
            status_path,
            {
                "worker_id": worker.worker_id,
                "status": status,
                "started_at": started_at,
                "completed_at": _utc_now(),
                "worker_fingerprint": expected_fingerprint,
                "error_type": type(exc).__name__,
                "error": str(exc),
            },
        )
        return {"worker_id": worker.worker_id, "status": status, "error": type(exc).__name__}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="run one generation worker inside a Modal Sandbox")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--worker-id", required=True)
    return parser


def main() -> int:
    args = _build_parser().parse_args()
    manifest = load_generation_manifest(args.manifest)
    worker = next(
        (item for item in manifest.workers if item.worker_id == args.worker_id),
        None,
    )
    if worker is None:
        raise ManifestError(f"worker {args.worker_id!r} is not declared in the manifest")
    result = run_worker(manifest, worker)
    print(json.dumps(result, sort_keys=True))
    if result["status"] == "failed":
        return 1
    if result["status"] == "rejected":
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
