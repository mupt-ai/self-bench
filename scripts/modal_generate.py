"""Discover candidates locally, then fan them out to isolated Modal Sandboxes."""

from __future__ import annotations

import io
import json
import os
import subprocess
import uuid
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

import modal

from selfbench.agent_input import build_provenance_staging
from selfbench.modal_generation import (
    GenerationManifest,
    ManifestError,
    WorkerSpec,
    load_generation_manifest,
    merge_worker_artifacts,
)
from selfbench.modal_parent import discover_generation_manifest

APP_NAME = "selfbench-generation"
ARTIFACT_MOUNT = "/artifacts"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
VOLUME_NAME = os.environ.get("SELFBENCH_MODAL_VOLUME") or "selfbench-generation-artifacts"
SECRET_NAME = os.environ.get("SELFBENCH_MODAL_SECRET") or "selfbench-generation"
MAX_WORKERS = int(os.environ.get("SELFBENCH_MODAL_MAX_WORKERS") or "20")

PI_VERSION = "0.83.0"
GH_VERSION = "2.89.0"
GH_LINUX_AMD64_SHA256 = "d0422caade520530e76c1c558da47daebaa8e1203d6b7ff10ad7d6faba3490d8"
UV_VERSION = "0.11.3"
BUN_VERSION = "1.1.42"
COREPACK_VERSION = "0.31.0"
GO_VERSION = "1.25.0"
RUST_VERSION = "1.90.0"
MAX_PROVENANCE_BYTES = 50 * 1024 * 1024
_BLOCKED_PROVENANCE_NAMES = {
    ".env",
    "api-keys",
    "auth.json",
    "credentials.json",
    "id_ed25519",
    "id_rsa",
}


def _local_git_state() -> tuple[str, bool]:
    commit = os.environ.get("SELFBENCH_BUILD_COMMIT")
    if commit:
        return commit, os.environ.get("SELFBENCH_BUILD_DIRTY") == "1"
    try:
        commit = subprocess.run(
            ["git", "-C", str(PROJECT_ROOT), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        dirty = bool(
            subprocess.run(
                ["git", "-C", str(PROJECT_ROOT), "status", "--short"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
        )
        return commit, dirty
    except (OSError, subprocess.CalledProcessError):
        return "unknown", True


BUILD_COMMIT, BUILD_DIRTY = _local_git_state()

image = (
    modal.Image.from_registry("node:24.11.1-bookworm-slim", add_python="3.12")
    .apt_install(
        "bash",
        "build-essential",
        "ca-certificates",
        "curl",
        "git",
        "jq",
        "pkg-config",
        "procps",
        "ripgrep",
        "unzip",
        "xz-utils",
    )
    .run_commands(
        "set -eu; "
        f"archive=gh_{GH_VERSION}_linux_amd64.tar.gz; "
        f"curl -fsSLO https://github.com/cli/cli/releases/download/v{GH_VERSION}/$archive; "
        f"echo '{GH_LINUX_AMD64_SHA256}  '$archive | sha256sum -c -; "
        "tar -xzf $archive; "
        f"install gh_{GH_VERSION}_linux_amd64/bin/gh /usr/local/bin/gh; "
        f"rm -rf $archive gh_{GH_VERSION}_linux_amd64"
    )
    .run_commands(
        f"npm install --global --ignore-scripts @earendil-works/pi-coding-agent@{PI_VERSION}",
        f"npm install --global bun@{BUN_VERSION} corepack@{COREPACK_VERSION}",
        "corepack enable",
        f"python -m pip install --no-cache-dir uv=={UV_VERSION}",
        "uv python install 3.11 3.12 3.13",
        (
            'arch="$(dpkg --print-architecture)"; '
            f'curl -fsSL "https://go.dev/dl/go{GO_VERSION}.linux-${{arch}}.tar.gz" '
            "| tar -C /usr/local -xz"
        ),
        (
            "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs "
            f"| env RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo sh -s -- "
            f"-y --no-modify-path --profile minimal --default-toolchain {RUST_VERSION}"
        ),
    )
    .add_local_dir(
        PROJECT_ROOT,
        "/opt/selfbench",
        copy=True,
        ignore=[
            ".git",
            ".venv",
            ".pytest_cache",
            "node_modules",
            "review/node_modules",
            "tasks",
            "results",
            "harbor-jobs",
            "harbor-tasks",
        ],
    )
    .run_commands("python -m pip install --no-cache-dir /opt/selfbench")
    .env(
        {
            "CARGO_HOME": "/usr/local/cargo",
            "PATH": "/usr/local/go/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin",
            "RUSTUP_HOME": "/usr/local/rustup",
            "SELFBENCH_BUILD_COMMIT": BUILD_COMMIT,
            "SELFBENCH_BUILD_DIRTY": "1" if BUILD_DIRTY else "0",
        }
    )
)

app = modal.App(APP_NAME)
artifact_volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)
provider_secret = modal.Secret.from_name(SECRET_NAME)


def _manifest_bytes(manifest: GenerationManifest) -> bytes:
    return (json.dumps(manifest.as_dict(), indent=2, sort_keys=True) + "\n").encode()


def _read_remote(path: str) -> bytes | None:
    try:
        return b"".join(artifact_volume.read_file(path))
    except FileNotFoundError:
        return None


def _default_provenance_roots(repo: Path | None) -> tuple[Path, ...]:
    home = Path.home()
    candidates = [
        home / ".pi" / "agent" / "sessions",
        home / ".claude" / "projects",
        home / ".codex" / "sessions",
        home / ".codex" / "archived_sessions",
        home / ".relaymux" / "state" / "implementation-notes",
        Path("/tmp/pi-handoffs"),
    ]
    if repo is not None:
        candidates.insert(0, repo.resolve())
    return tuple(path.resolve() for path in candidates if path.exists())


def _stage_manifest(manifest: GenerationManifest, repo: Path | None) -> GenerationManifest:
    """Upload allowlisted provenance and return the private remote manifest."""
    roots = _default_provenance_roots(repo)
    staged = manifest.as_dict()
    raw_workers = staged["workers"]
    assert isinstance(raw_workers, list)
    uploads: list[tuple[io.BytesIO, str]] = []
    for raw_worker in raw_workers:
        assert isinstance(raw_worker, dict)
        provenance = raw_worker.get("provenance")
        if not isinstance(provenance, dict) or provenance.get("kind") != "file":
            continue
        raw_path = provenance.get("path")
        if not isinstance(raw_path, str):
            raise ManifestError("file provenance path must be a string")
        source = Path(raw_path).expanduser().resolve()
        if not source.is_file() or not any(source.is_relative_to(root) for root in roots):
            allowed = ", ".join(str(root) for root in roots)
            raise ManifestError(f"provenance path is outside allowed roots: {source}; allowed: {allowed}")
        if source.name.lower() in _BLOCKED_PROVENANCE_NAMES:
            raise ManifestError(f"refusing to upload credential-like provenance file: {source.name}")
        size = source.stat().st_size
        if size > MAX_PROVENANCE_BYTES:
            raise ManifestError(
                f"provenance file exceeds {MAX_PROVENANCE_BYTES} bytes: {source}"
            )
        source_format = str(provenance.get("format", "auto"))
        message_index = int(provenance.get("message_index", 0))
        try:
            sanitized, remote_path, rewritten = build_provenance_staging(
                source,
                run_id=manifest.run_id,
                worker_id=str(raw_worker["worker_id"]),
                artifact_mount=ARTIFACT_MOUNT,
                source_format=source_format,
                message_index=message_index,
            )
        except (OSError, ValueError) as exc:
            raise ManifestError(f"cannot sanitize provenance {source}: {exc}") from exc
        # The staged artifact is one generic user message containing only the
        # selected, redacted prompt. No other source-session records upload.
        provenance.update(rewritten)
        if _read_remote(remote_path) is None:
            uploads.append((io.BytesIO(sanitized), remote_path))

    remote_manifest = GenerationManifest.from_dict(staged)
    manifest_path = f"runs/{manifest.run_id}/manifest.json"
    expected_manifest = _manifest_bytes(remote_manifest)
    existing_manifest = _read_remote(manifest_path)
    if existing_manifest is not None and existing_manifest != expected_manifest:
        raise RuntimeError(
            f"run_id {manifest.run_id!r} already has a different manifest in {VOLUME_NAME}"
        )
    if uploads or existing_manifest is None:
        with artifact_volume.batch_upload() as batch:
            for sanitized, remote_path in uploads:
                batch.put_file(sanitized, remote_path)
            if existing_manifest is None:
                batch.put_file(io.BytesIO(expected_manifest), manifest_path)
    return remote_manifest


def _sandbox_name(manifest: GenerationManifest, worker: WorkerSpec) -> str:
    fingerprint = manifest.worker_fingerprint(worker)
    attempt = uuid.uuid4().hex[:8]
    return f"{manifest.run_id[:16]}-{worker.worker_id[:16]}-{fingerprint[:8]}-{attempt}"


def _launch_worker(
    manifest: GenerationManifest,
    remote_manifest: str,
    worker: WorkerSpec,
) -> modal.Sandbox:
    return modal.Sandbox.create(
        "python",
        "-m",
        "selfbench.modal_worker",
        "--manifest",
        remote_manifest,
        "--worker-id",
        worker.worker_id,
        app=app,
        name=_sandbox_name(manifest, worker),
        tags={
            "run_id": manifest.run_id,
            "worker_id": worker.worker_id,
            "selfbench_commit": BUILD_COMMIT,
        },
        image=image,
        secrets=[provider_secret],
        volumes={ARTIFACT_MOUNT: artifact_volume},
        timeout=6 * 60 * 60,
        cpu=4,
        memory=8192,
        workdir="/work",
    )


def _worker_status(manifest: GenerationManifest, worker: WorkerSpec) -> dict[str, object] | None:
    raw = _read_remote(f"runs/{manifest.run_id}/statuses/{worker.worker_id}.json")
    if raw is None:
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid remote status for {worker.worker_id}: {exc}") from exc
    if not isinstance(value, dict):
        raise TypeError(f"invalid remote status for {worker.worker_id}")
    if value.get("worker_fingerprint") != manifest.worker_fingerprint(worker):
        raise RuntimeError(f"stale remote status for {worker.worker_id}")
    return value


def _run_generation(manifest: GenerationManifest) -> None:
    remote_manifest = f"{ARTIFACT_MOUNT}/runs/{manifest.run_id}/manifest.json"
    completed: set[str] = set()
    rejected: set[str] = set()
    for worker in manifest.workers:
        status = _worker_status(manifest, worker)
        if status is not None and status.get("status") == "complete":
            completed.add(worker.worker_id)
        elif status is not None and status.get("status") == "rejected":
            rejected.add(worker.worker_id)

    while len(completed) < manifest.target_count:
        deficit = manifest.target_count - len(completed)
        candidates = [
            worker
            for worker in manifest.workers
            if worker.worker_id not in completed and worker.worker_id not in rejected
        ]
        wave = candidates[: min(deficit, MAX_WORKERS)]
        if not wave:
            raise RuntimeError(
                f"candidate pool exhausted at {len(completed)}/{manifest.target_count} authored tasks"
            )
        print(
            f"starting {len(wave)} Pi subagents in separate Modal Sandboxes "
            f"({len(completed)}/{manifest.target_count} complete)"
        )
        sandboxes = [
            (worker, _launch_worker(manifest, remote_manifest, worker))
            for worker in wave
        ]
        infrastructure_failures: list[str] = []
        for worker, sandbox in sandboxes:
            sandbox.wait(raise_on_termination=False)
            output = sandbox.stdout.read().strip()
            if output:
                print(output)
            status = _worker_status(manifest, worker)
            state = status.get("status") if status is not None else None
            if state == "complete":
                completed.add(worker.worker_id)
            elif state == "rejected":
                rejected.add(worker.worker_id)
            else:
                infrastructure_failures.append(worker.worker_id)
        if infrastructure_failures:
            joined = ", ".join(infrastructure_failures)
            raise RuntimeError(
                f"sandbox infrastructure/agent failure for {joined}; retry the same run before consuming reserves"
            )

    print(
        f"generation complete: {len(completed)} tasks authored, {len(rejected)} candidates rejected"
    )


def _download_and_merge(run_id: str, output: Path, artifacts_dir: Path) -> dict[str, object]:
    remote_prefix = f"runs/{run_id}"
    local_run = artifacts_dir / run_id
    local_run.mkdir(parents=True, exist_ok=True)
    entries = artifact_volume.listdir(remote_prefix, recursive=True)
    for entry in entries:
        if entry.type.name != "FILE":
            continue
        relative = PurePosixPath(entry.path).relative_to(PurePosixPath(remote_prefix))
        destination = local_run.joinpath(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("wb") as handle:
            for chunk in artifact_volume.read_file(entry.path):
                handle.write(chunk)
    manifest = load_generation_manifest(local_run / "manifest.json")
    return merge_worker_artifacts(manifest, local_run, output)


def _require_clean_build() -> None:
    if BUILD_COMMIT == "unknown" or BUILD_DIRTY:
        raise RuntimeError(
            "refusing to submit from an unknown or dirty SelfBench checkout; commit the app first"
        )


@app.local_entrypoint()
def run(
    repo: str,
    count: int,
    tasks_root: str = "tasks",
    profile: str = "hard",
    provider: str = "openai",
    model: str = "gpt-5.6-sol",
    thinking: str = "xhigh",
    reserve_count: int = 0,
    run_id: str = "",
    pi_executable: str = "pi",
) -> None:
    """Run local discovery, cloud authoring, and local artifact reduction."""
    _require_clean_build()
    source_repo = Path(repo).expanduser().resolve()
    local_tasks = Path(tasks_root).expanduser().resolve()
    reserves = count if reserve_count == 0 else reserve_count
    resolved_run_id = run_id or (
        datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    )
    local_state = Path.home() / ".local" / "share" / "selfbench" / "modal-runs"
    plan_dir = local_state / resolved_run_id
    manifest = discover_generation_manifest(
        source_repo,
        local_tasks,
        plan_dir / "plan.json",
        plan_dir / "parent.jsonl",
        run_id=resolved_run_id,
        target_count=count,
        reserve_count=reserves,
        profile=profile,
        provider=provider,
        model=model,
        thinking=thinking or None,
        pi_executable=pi_executable,
    )
    remote_manifest = _stage_manifest(manifest, source_repo)
    _run_generation(remote_manifest)
    report = _download_and_merge(
        resolved_run_id,
        local_tasks,
        local_state / "artifacts",
    )
    print(json.dumps(report, indent=2))
    print("generation artifacts are local; run deterministic validate-batch before accepting them")


@app.local_entrypoint()
def submit(manifest: str, repo: str = "") -> None:
    """Resume or submit an already-reviewed local parent manifest."""
    _require_clean_build()
    generation = load_generation_manifest(Path(manifest))
    source_repo = Path(repo).expanduser().resolve() if repo else None
    remote_manifest = _stage_manifest(generation, source_repo)
    _run_generation(remote_manifest)


@app.local_entrypoint()
def pull(run_id: str, output: str = "tasks", artifacts_dir: str = "") -> None:
    """Download, verify, and idempotently merge one completed run."""
    local_artifacts = (
        Path(artifacts_dir).expanduser().resolve()
        if artifacts_dir
        else Path.home() / ".local" / "share" / "selfbench" / "modal-runs" / "artifacts"
    )
    report = _download_and_merge(
        run_id,
        Path(output).expanduser().resolve(),
        local_artifacts,
    )
    print(json.dumps(report, indent=2))
