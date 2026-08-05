"""Manifest and artifact helpers for standalone Modal task generation."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from .agent_input import SUPPORTED_FORMATS

SCHEMA_VERSION = 1
_SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
_PULL_PATH = re.compile(r"^/(?P<owner>[^/]+)/(?P<repo>[^/]+)/pull/(?P<number>[1-9][0-9]*)/?$")


class ManifestError(ValueError):
    """Raised when a generation manifest or artifact set is invalid."""


def _require_object(value: object, field: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ManifestError(f"{field} must be an object")
    return value


def _require_string(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ManifestError(f"{field} must be a non-empty string")
    return value.strip()


def _require_safe_id(value: object, field: str) -> str:
    parsed = _require_string(value, field)
    if _SAFE_ID.fullmatch(parsed) is None:
        raise ManifestError(f"{field} must be a path-safe identifier")
    return parsed


def _optional_string(value: object, field: str) -> str | None:
    if value is None:
        return None
    return _require_string(value, field)


def _positive_int(value: object, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ManifestError(f"{field} must be a positive integer")
    return value


@dataclass(frozen=True)
class AgentSpec:
    provider: str
    model: str
    thinking: str | None
    profile: str
    request: str | None

    @classmethod
    def from_dict(cls, raw: object) -> AgentSpec:
        data = _require_object(raw, "agent")
        profile = _require_string(data.get("profile", "default"), "agent.profile")
        if profile not in {"default", "hard"}:
            raise ManifestError("agent.profile must be 'default' or 'hard'")
        return cls(
            provider=_require_string(data.get("provider"), "agent.provider"),
            model=_require_string(data.get("model"), "agent.model"),
            thinking=_optional_string(data.get("thinking"), "agent.thinking"),
            profile=profile,
            request=_optional_string(data.get("request"), "agent.request"),
        )

    def as_dict(self) -> dict[str, object]:
        return {
            "provider": self.provider,
            "model": self.model,
            "thinking": self.thinking,
            "profile": self.profile,
            "request": self.request,
        }


@dataclass(frozen=True)
class WorkerSpec:
    worker_id: str
    candidates: tuple[str, ...]
    target_count: int
    source_pr: int | None
    base_commit: str | None
    completed_commit: str | None
    provenance: dict[str, object] | None
    request: str | None

    @classmethod
    def from_dict(cls, raw: object, index: int) -> WorkerSpec:
        data = _require_object(raw, f"workers[{index}]")
        worker_id = _require_safe_id(data.get("worker_id"), f"workers[{index}].worker_id")
        raw_candidates = data.get("candidates")
        if not isinstance(raw_candidates, list) or not raw_candidates:
            raise ManifestError(f"workers[{index}].candidates must be a non-empty list")
        candidates = tuple(
            _require_string(candidate, f"workers[{index}].candidates[{candidate_index}]")
            for candidate_index, candidate in enumerate(raw_candidates)
        )
        candidate_keys = [normalize_candidate(candidate) for candidate in candidates]
        if len(candidate_keys) != len(set(candidate_keys)):
            raise ManifestError(f"workers[{index}].candidates must not contain duplicates")
        target_count = _positive_int(
            data.get("target_count", len(candidates)),
            f"workers[{index}].target_count",
        )
        if target_count > len(candidates):
            raise ManifestError(
                f"workers[{index}].target_count cannot exceed its candidate count"
            )
        source_pr = data.get("source_pr")
        if source_pr is not None and (
            not isinstance(source_pr, int) or isinstance(source_pr, bool) or source_pr < 1
        ):
            raise ManifestError(f"workers[{index}].source_pr must be a positive integer")
        base_commit = _optional_commit(data.get("base_commit"), f"workers[{index}].base_commit")
        completed_commit = _optional_commit(
            data.get("completed_commit"),
            f"workers[{index}].completed_commit",
        )
        raw_provenance = data.get("provenance")
        provenance = None
        if raw_provenance is not None:
            provenance = _validate_provenance(raw_provenance, f"workers[{index}].provenance")
        return cls(
            worker_id=worker_id,
            candidates=candidates,
            target_count=target_count,
            source_pr=source_pr,
            base_commit=base_commit,
            completed_commit=completed_commit,
            provenance=provenance,
            request=_optional_string(data.get("request"), f"workers[{index}].request"),
        )

    def as_dict(self) -> dict[str, object]:
        result: dict[str, object] = {
            "worker_id": self.worker_id,
            "candidates": list(self.candidates),
            "target_count": self.target_count,
        }
        if self.source_pr is not None:
            result["source_pr"] = self.source_pr
        if self.base_commit is not None:
            result["base_commit"] = self.base_commit
        if self.completed_commit is not None:
            result["completed_commit"] = self.completed_commit
        if self.provenance is not None:
            result["provenance"] = self.provenance
        if self.request is not None:
            result["request"] = self.request
        return result


@dataclass(frozen=True)
class GenerationManifest:
    run_id: str
    target_count: int
    source_repo_url: str
    source_commit: str
    agent: AgentSpec
    workers: tuple[WorkerSpec, ...]

    @classmethod
    def from_dict(cls, raw: object) -> GenerationManifest:
        data = _require_object(raw, "manifest")
        version = data.get("schema_version")
        if version != SCHEMA_VERSION:
            raise ManifestError(
                f"schema_version must be {SCHEMA_VERSION}, got {version!r}"
            )
        source = _require_object(data.get("source"), "source")
        raw_workers = data.get("workers")
        if not isinstance(raw_workers, list) or not raw_workers:
            raise ManifestError("workers must be a non-empty list")
        workers = tuple(WorkerSpec.from_dict(worker, index) for index, worker in enumerate(raw_workers))
        worker_ids = [worker.worker_id for worker in workers]
        if len(worker_ids) != len(set(worker_ids)):
            raise ManifestError("worker_id values must be unique")
        candidate_keys = [
            normalize_candidate(candidate)
            for worker in workers
            for candidate in worker.candidates
        ]
        if len(candidate_keys) != len(set(candidate_keys)):
            raise ManifestError("candidates must be disjoint across workers")
        target_count = _positive_int(
            data.get("target_count", sum(worker.target_count for worker in workers)),
            "target_count",
        )
        available_count = sum(worker.target_count for worker in workers)
        if target_count > available_count:
            raise ManifestError("target_count cannot exceed the planned worker capacity")
        return cls(
            run_id=_require_safe_id(data.get("run_id"), "run_id"),
            target_count=target_count,
            source_repo_url=_require_repo_url(source.get("repo_url")),
            source_commit=_require_commit(source.get("commit")),
            agent=AgentSpec.from_dict(data.get("agent")),
            workers=workers,
        )

    def as_dict(self) -> dict[str, object]:
        return {
            "schema_version": SCHEMA_VERSION,
            "run_id": self.run_id,
            "target_count": self.target_count,
            "source": {
                "repo_url": self.source_repo_url,
                "commit": self.source_commit,
            },
            "agent": self.agent.as_dict(),
            "workers": [worker.as_dict() for worker in self.workers],
        }

    @property
    def fingerprint(self) -> str:
        return _json_sha256(self.as_dict())

    def worker_fingerprint(self, worker: WorkerSpec) -> str:
        return _json_sha256(
            {
                "manifest": self.fingerprint,
                "worker": worker.as_dict(),
            }
        )


@dataclass(frozen=True)
class GeneratedTask:
    task_id: str
    source_key: str
    directory: Path
    tree_sha256: str


def load_generation_manifest(path: Path) -> GenerationManifest:
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ManifestError(f"could not read generation manifest {path}: {exc}") from exc
    return GenerationManifest.from_dict(raw)


def normalize_candidate(candidate: str, *, repo_url: str | None = None) -> str:
    """Return a stable key for a PR URL, PR number, or opaque candidate ID."""
    value = candidate.strip()
    parsed = urlsplit(value)
    match = _PULL_PATH.fullmatch(parsed.path) if parsed.scheme and parsed.netloc else None
    if match is not None:
        return (
            f"{parsed.netloc.lower()}/{match.group('owner')}/{match.group('repo')}"
            f"#{match.group('number')}"
        ).lower()
    number_match = re.fullmatch(r"#?([1-9][0-9]*)", value)
    if number_match is not None and repo_url is not None:
        return f"{_repo_key(repo_url)}#{number_match.group(1)}".lower()
    if parsed.scheme and parsed.netloc:
        normalized = urlunsplit(
            (parsed.scheme.lower(), parsed.netloc.lower(), parsed.path.rstrip("/"), "", "")
        )
        return normalized
    return value


def build_worker_request(manifest: GenerationManifest, worker: WorkerSpec) -> str:
    candidates = "\n".join(f"- {candidate}" for candidate in worker.candidates)
    extra = f"\n\nAdditional run request:\n{manifest.agent.request}" if manifest.agent.request else ""
    worker_request = f"\n\nCandidate-specific notes:\n{worker.request}" if worker.request else ""
    commit_lines = []
    if worker.base_commit is not None:
        commit_lines.append(f"Base commit: {worker.base_commit}")
    if worker.completed_commit is not None:
        commit_lines.append(f"Completed commit: {worker.completed_commit}")
    if worker.provenance is not None:
        commit_lines.append(
            "Authentic provenance descriptor: "
            + json.dumps(worker.provenance, sort_keys=True, separators=(",", ":"))
        )
    assignment = "\n".join(commit_lines)
    assignment_section = f"\n\nPinned assignment metadata:\n{assignment}" if assignment else ""
    return (
        f"This is isolated generation shard {worker.worker_id}. Use only the assigned merged "
        f"change candidates below and create exactly {worker.target_count} complete task "
        "directories. Do not discover, reserve, or author any candidate outside this list. "
        "If an assigned candidate is not viable, record the concrete rejection and stop short; "
        "do not substitute another pull request. Author only in this worker. Do not run Harbor, "
        "solver trials, or deterministic nop/oracle validation here; centralized validation "
        "runs after the artifacts are pulled and merged. Before accepting the task, prove its "
        "repository-native setup command in a clean checkout at the pinned base commit, using the "
        "snapshot's declared package manager and frozen lockfile exactly as a SWE-bench environment "
        "would. Never repair setup by changing a lockfile or silently switching package managers.\n\n"
        "Assigned candidates:\n"
        f"{candidates}{assignment_section}{worker_request}{extra}"
    )


def write_worker_artifact_manifest(
    worker_root: Path,
    tasks_root: Path,
    manifest: GenerationManifest,
    worker: WorkerSpec,
    *,
    build_commit: str,
) -> dict[str, object]:
    tasks = _inspect_tasks(tasks_root, manifest.source_repo_url, worker)
    if len(tasks) != worker.target_count:
        raise ManifestError(
            f"worker {worker.worker_id} produced {len(tasks)} tasks; expected {worker.target_count}"
        )
    files = _file_manifest(tasks_root)
    artifact = {
        "schema_version": SCHEMA_VERSION,
        "run_id": manifest.run_id,
        "run_fingerprint": manifest.fingerprint,
        "worker_id": worker.worker_id,
        "worker_fingerprint": manifest.worker_fingerprint(worker),
        "selfbench_commit": build_commit,
        "candidates": list(worker.candidates),
        "tasks": [
            {
                "task_id": task.task_id,
                "source_key": task.source_key,
                "tree_sha256": task.tree_sha256,
            }
            for task in tasks
        ],
        "files": files,
    }
    setup_preflight = worker_root / "setup-preflight.json"
    if setup_preflight.is_file():
        artifact["setup_preflight_sha256"] = hashlib.sha256(
            setup_preflight.read_bytes()
        ).hexdigest()
    elif worker.base_commit is not None:
        raise ManifestError(f"worker {worker.worker_id} is missing setup-preflight.json")
    _atomic_write_json(worker_root / "artifacts.json", artifact)
    return artifact


def verify_worker_artifacts(
    worker_root: Path,
    manifest: GenerationManifest,
    worker: WorkerSpec,
) -> list[GeneratedTask]:
    success_path = worker_root / "_SUCCESS"
    if not success_path.is_file():
        raise ManifestError(f"worker {worker.worker_id} has no _SUCCESS marker")
    if success_path.read_text().strip() != manifest.worker_fingerprint(worker):
        raise ManifestError(f"worker {worker.worker_id} has a stale completion marker")
    artifact_path = worker_root / "artifacts.json"
    try:
        artifact = json.loads(artifact_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ManifestError(f"invalid artifact manifest for {worker.worker_id}: {exc}") from exc
    if not isinstance(artifact, dict):
        raise ManifestError(f"artifact manifest for {worker.worker_id} must be an object")
    expected_fields = {
        "run_id": manifest.run_id,
        "run_fingerprint": manifest.fingerprint,
        "worker_id": worker.worker_id,
        "worker_fingerprint": manifest.worker_fingerprint(worker),
    }
    for field, expected in expected_fields.items():
        if artifact.get(field) != expected:
            raise ManifestError(f"worker {worker.worker_id} artifact {field} does not match")
    setup_preflight = worker_root / "setup-preflight.json"
    expected_setup_hash = artifact.get("setup_preflight_sha256")
    if worker.base_commit is not None and not isinstance(expected_setup_hash, str):
        raise ManifestError(f"worker {worker.worker_id} has no setup preflight hash")
    if isinstance(expected_setup_hash, str) and (
        not setup_preflight.is_file()
        or hashlib.sha256(setup_preflight.read_bytes()).hexdigest() != expected_setup_hash
    ):
        raise ManifestError(f"worker {worker.worker_id} setup preflight hash does not match")

    tasks_root = worker_root / "tasks"
    expected_files = artifact.get("files")
    if not isinstance(expected_files, list) or expected_files != _file_manifest(tasks_root):
        raise ManifestError(f"worker {worker.worker_id} task artifact hashes do not match")
    tasks = _inspect_tasks(tasks_root, manifest.source_repo_url, worker)
    expected_tasks = artifact.get("tasks")
    actual_tasks = [
        {
            "task_id": task.task_id,
            "source_key": task.source_key,
            "tree_sha256": task.tree_sha256,
        }
        for task in tasks
    ]
    if expected_tasks != actual_tasks:
        raise ManifestError(f"worker {worker.worker_id} task index does not match")
    if len(tasks) != worker.target_count:
        raise ManifestError(
            f"worker {worker.worker_id} has {len(tasks)} tasks; expected {worker.target_count}"
        )
    return tasks


def merge_worker_artifacts(
    manifest: GenerationManifest,
    artifact_run_root: Path,
    output_root: Path,
) -> dict[str, object]:
    """Verify completed workers and idempotently merge their task directories."""
    output_root.mkdir(parents=True, exist_ok=True)
    tasks: list[tuple[str, GeneratedTask]] = []
    seen_ids: set[str] = set()
    seen_sources: set[str] = set()
    for worker in manifest.workers:
        worker_root = artifact_run_root / "workers" / worker.worker_id
        if not (worker_root / "_SUCCESS").is_file():
            continue
        for task in verify_worker_artifacts(worker_root, manifest, worker):
            if task.task_id in seen_ids:
                raise ManifestError(f"duplicate generated task_id: {task.task_id}")
            if task.source_key in seen_sources:
                raise ManifestError(f"duplicate generated source candidate: {task.source_key}")
            seen_ids.add(task.task_id)
            seen_sources.add(task.source_key)
            tasks.append((worker.worker_id, task))

    if len(tasks) != manifest.target_count:
        raise ManifestError(
            f"run has {len(tasks)} completed tasks; expected exactly {manifest.target_count}"
        )

    for _, task in tasks:
        destination = output_root / task.task_id
        if destination.exists():
            if not destination.is_dir() or _tree_sha256(destination) != task.tree_sha256:
                raise ManifestError(f"existing task conflicts with generated task: {task.task_id}")
            continue
        staging = output_root / f".{task.task_id}.tmp-{os.getpid()}"
        if staging.exists():
            shutil.rmtree(staging)
        shutil.copytree(task.directory, staging)
        os.replace(staging, destination)

    report = {
        "schema_version": SCHEMA_VERSION,
        "run_id": manifest.run_id,
        "run_fingerprint": manifest.fingerprint,
        "tasks": [
            {
                "task_id": task.task_id,
                "source_key": task.source_key,
                "worker_id": worker_id,
                "tree_sha256": task.tree_sha256,
            }
            for worker_id, task in sorted(tasks, key=lambda item: item[1].task_id)
        ],
    }
    _atomic_write_json(output_root / ".selfbench-generation.json", report)
    return report


def _inspect_tasks(
    tasks_root: Path,
    repo_url: str,
    worker: WorkerSpec,
) -> list[GeneratedTask]:
    if not tasks_root.is_dir():
        return []
    allowed_sources = {
        normalize_candidate(candidate, repo_url=repo_url) for candidate in worker.candidates
    }
    tasks: list[GeneratedTask] = []
    for task_dir in sorted(tasks_root.iterdir()):
        if not task_dir.is_dir() or not (task_dir / "task.json").is_file():
            continue
        if task_dir.is_symlink():
            raise ManifestError(f"task directory must not be a symlink: {task_dir.name}")
        try:
            task_data = json.loads((task_dir / "task.json").read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise ManifestError(f"invalid task.json in {task_dir}: {exc}") from exc
        if not isinstance(task_data, dict):
            raise ManifestError(f"task.json in {task_dir} must be an object")
        task_id = _require_safe_id(task_data.get("task_id"), f"{task_dir.name}.task_id")
        if task_id != task_dir.name:
            raise ManifestError(f"task_id {task_id!r} does not match directory {task_dir.name!r}")
        source_key = _task_source_key(task_data, repo_url)
        if source_key not in allowed_sources:
            raise ManifestError(
                f"task {task_id} provenance {source_key!r} is not assigned to {worker.worker_id}"
            )
        if worker.source_pr is not None and task_data.get("source_pr") != worker.source_pr:
            raise ManifestError(
                f"task {task_id} source_pr does not match assigned PR {worker.source_pr}"
            )
        if worker.base_commit is not None and task_data.get("base_commit") != worker.base_commit:
            raise ManifestError(
                f"task {task_id} base_commit does not match its pinned candidate"
            )
        tasks.append(
            GeneratedTask(
                task_id=task_id,
                source_key=source_key,
                directory=task_dir,
                tree_sha256=_tree_sha256(task_dir),
            )
        )
    source_keys = [task.source_key for task in tasks]
    if len(source_keys) != len(set(source_keys)):
        raise ManifestError(f"worker {worker.worker_id} produced duplicate source candidates")
    return tasks


def _task_source_key(task_data: dict[str, Any], repo_url: str) -> str:
    source_url = task_data.get("source_url")
    if isinstance(source_url, str) and source_url.strip():
        return normalize_candidate(source_url, repo_url=repo_url)
    source_pr = task_data.get("source_pr")
    if isinstance(source_pr, int) and not isinstance(source_pr, bool) and source_pr > 0:
        return normalize_candidate(str(source_pr), repo_url=repo_url)
    raise ManifestError("generated task must include source_url or a positive source_pr")


def _repo_key(repo_url: str) -> str:
    parsed = urlsplit(repo_url)
    path = parsed.path.rstrip("/").removesuffix(".git")
    if parsed.netloc and path.count("/") >= 2:
        return f"{parsed.netloc.lower()}{path}".lower()
    scp_match = re.fullmatch(r"[^@]+@([^:]+):(.+?)(?:\.git)?", repo_url)
    if scp_match is not None:
        return f"{scp_match.group(1)}/{scp_match.group(2)}".lower()
    return repo_url.rstrip("/").removesuffix(".git").lower()


def _require_repo_url(value: object) -> str:
    repo_url = _require_string(value, "source.repo_url")
    parsed = urlsplit(repo_url)
    is_network_url = parsed.scheme in {"https", "ssh"} and bool(parsed.netloc)
    is_scp_url = re.fullmatch(r"[^@\s]+@[^:\s]+:.+", repo_url) is not None
    if not is_network_url and not is_scp_url:
        raise ManifestError("source.repo_url must be an https or SSH Git URL")
    return repo_url


def _require_commit(value: object) -> str:
    commit = _require_string(value, "source.commit")
    if re.fullmatch(r"[0-9a-fA-F]{40}", commit) is None:
        raise ManifestError("source.commit must be a full 40-character commit SHA")
    return commit.lower()


def _optional_commit(value: object, field: str) -> str | None:
    if value is None:
        return None
    commit = _require_string(value, field)
    if re.fullmatch(r"[0-9a-fA-F]{40}", commit) is None:
        raise ManifestError(f"{field} must be a full 40-character commit SHA")
    return commit.lower()


def _validate_provenance(value: object, field: str) -> dict[str, object]:
    data = _require_object(value, field)
    kind = _require_string(data.get("kind"), f"{field}.kind")
    if kind == "file":
        path = _require_string(data.get("path"), f"{field}.path")
        source_format = _require_string(data.get("format", "auto"), f"{field}.format")
        if source_format not in SUPPORTED_FORMATS:
            supported = ", ".join(sorted(SUPPORTED_FORMATS))
            raise ManifestError(f"{field}.format must be one of {supported}")
        message_index = data.get("message_index", 0)
        if not isinstance(message_index, int) or isinstance(message_index, bool) or message_index < 0:
            raise ManifestError(f"{field}.message_index must be a non-negative integer")
        result: dict[str, object] = {
            "kind": kind,
            "path": path,
            "format": source_format,
            "message_index": message_index,
        }
        sha256 = data.get("sha256")
        if sha256 is not None:
            checksum = _require_string(sha256, f"{field}.sha256")
            if re.fullmatch(r"[0-9a-fA-F]{64}", checksum) is None:
                raise ManifestError(f"{field}.sha256 must be a SHA-256 hex digest")
            result["sha256"] = checksum.lower()
        return result
    if kind == "url":
        return {
            "kind": kind,
            "url": _require_string(data.get("url"), f"{field}.url"),
        }
    raise ManifestError(f"{field}.kind must be 'file' or 'url'")


def _file_manifest(root: Path) -> list[dict[str, object]]:
    if not root.is_dir():
        return []
    files: list[dict[str, object]] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ManifestError(f"artifact symlinks are not allowed: {path.relative_to(root)}")
        if not path.is_file():
            continue
        files.append(
            {
                "path": path.relative_to(root).as_posix(),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "size": path.stat().st_size,
            }
        )
    return files


def _tree_sha256(root: Path) -> str:
    return _json_sha256(_file_manifest(root))


def _json_sha256(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _atomic_write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    os.replace(temporary, path)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="verify and merge downloaded Modal generation artifacts")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument(
        "--artifacts",
        type=Path,
        required=True,
        help="downloaded run directory containing workers/",
    )
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main() -> int:
    args = _build_parser().parse_args()
    try:
        manifest = load_generation_manifest(args.manifest)
        report = merge_worker_artifacts(manifest, args.artifacts, args.output)
    except ManifestError as exc:
        print(f"error: {exc}")
        return 1
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
