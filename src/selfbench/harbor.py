"""Harbor-shaped environments for selfbench tasks.

selfbench owns authoring, provenance, quality audit, and review. This module owns
only the environment an eval executes in: it compiles a selfbench task into a
Harbor-format task directory and runs it on Harbor, which is the default runtime.
The compiled environment is sealed, so authoring inputs such as source
transcripts, task.json, and the gold patch never reach the agent.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .task import Task, resolve_toolchains

HARBOR_SCHEMA_VERSION = "1.4"
HARBOR_VERSION_RANGE = ">=0.20.1.dev202607200228,<0.21"
ENVIRONMENT_COMPILER_REVISION = 5
_BASE_IMAGE = "ubuntu:24.04"
_GO_VERSION = "1.25.0"
_RUST_VERSION = "1.90.0"
_PYTHON_VERSIONS = "3.12 3.11 3.13"
_NODE_VERSION = "22.14.0"
_NODE_NPM_VERSION = "10.9.2"
_BUN_VERSION = "1.1.42"
GENERATED_MANIFEST = ".selfbench-manifest.json"

_JS_LOCKFILES = {
    "npm": ("npm-shrinkwrap.json", "package-lock.json"),
    "pnpm": ("pnpm-lock.yaml",),
    "yarn": ("yarn.lock",),
    "bun": ("bun.lock", "bun.lockb"),
}
_SUPPORTED_JS_MANAGERS = frozenset(_JS_LOCKFILES)
_EXACT_PACKAGE_MANAGER_VERSION = re.compile(
    r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"
)


@dataclass(frozen=True)
class HarborRun:
    job_dir: Path
    trial_dir: Path
    job_result: dict[str, Any]
    trial_result: dict[str, Any]

    @property
    def rewards(self) -> dict[str, float | int]:
        verifier = self.trial_result.get("verifier_result")
        if not isinstance(verifier, dict):
            return {}
        rewards = verifier.get("rewards")
        return rewards if isinstance(rewards, dict) else {}

    @property
    def exception(self) -> dict[str, Any] | None:
        value = self.trial_result.get("exception_info")
        return value if isinstance(value, dict) else None


@dataclass(frozen=True)
class PackageManagerProfile:
    """Resolved native JavaScript package-manager inputs from one snapshot."""

    manager: str
    version: str
    specifier: str
    package_json_sha256: str
    lockfiles: tuple[tuple[str, str], ...]

    def as_dict(self) -> dict[str, object]:
        return {
            "manager": self.manager,
            "version": self.version,
            "specifier": self.specifier,
            "package_json_sha256": self.package_json_sha256,
            "lockfiles": [
                {"path": path, "sha256": checksum}
                for path, checksum in self.lockfiles
            ],
        }


def build_harbor_task(
    task: Task,
    local_repo: Path,
    output_root: Path,
    *,
    org: str = "selfbench",
    overwrite: bool = False,
) -> Path:
    """Build a sealed Harbor task without source transcripts or task.json."""
    local_repo = local_repo.resolve()
    output_root = output_root.resolve()
    _check_commit(local_repo, task.base_commit)
    task_name = f"{_harbor_name(org)}/{_harbor_name(task.task_id)}"
    package_profile = _package_manager_profile(local_repo, task)
    destination = output_root / task.task_id
    if destination.exists() and not overwrite:
        manifest = _read_json(destination / GENERATED_MANIFEST)
        if (
            isinstance(manifest, dict)
            and manifest.get("environment_compiler_revision") == ENVIRONMENT_COMPILER_REVISION
            and manifest.get("task_fingerprints") == task.evaluation_fingerprints
            and manifest.get("package_manager_profile") == _profile_manifest_value(package_profile)
        ):
            return destination
        raise FileExistsError(
            f"{destination} already exists and is not current; pass --force to replace it"
        )

    output_root.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{task.task_id}-", dir=output_root))
    try:
        _write_harbor_task(staging, task, local_repo, task_name, package_profile)
        if destination.exists():
            shutil.rmtree(destination)
        staging.replace(destination)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return destination


def run_harbor_task(
    harbor_task_dir: Path,
    jobs_root: Path,
    *,
    agent: str,
    model: str | None = None,
    environment: str = "docker",
    agent_kwargs: dict[str, str] | None = None,
    agent_env: dict[str, str] | None = None,
    allow_agent_hosts: list[str] | None = None,
    quiet: bool = False,
    log_path: Path | None = None,
) -> HarborRun:
    """Run one native Harbor trial and return its canonical result artifacts."""
    harbor = _require_harbor()
    harbor_task_dir = harbor_task_dir.resolve()
    jobs_root = jobs_root.resolve()
    jobs_root.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
    job_name = f"{harbor_task_dir.name}-{agent}-{timestamp}-{uuid.uuid4().hex[:8]}"
    command = [
        str(harbor),
        "run",
        "--path",
        str(harbor_task_dir),
        "--agent",
        agent,
        "--env",
        environment,
        "--job-name",
        job_name,
        "--jobs-dir",
        str(jobs_root),
        "--delete",
    ]
    if model is not None:
        command.extend(["--model", model])
    for key, value in sorted((agent_kwargs or {}).items()):
        command.extend(["--agent-kwarg", f"{key}={value}"])
    for key, value in sorted((agent_env or {}).items()):
        command.extend(["--agent-env", f"{key}={value}"])
    for host in dict.fromkeys(allow_agent_hosts or []):
        command.extend(["--allow-agent-host", host])
    if quiet:
        command.append("--quiet")

    if log_path is None:
        result = subprocess.run(command, text=True, check=False)
    else:
        log_path = log_path.resolve()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a") as log:
            result = subprocess.run(
                command,
                text=True,
                stdout=log,
                stderr=subprocess.STDOUT,
                check=False,
            )
    job_dir = jobs_root / job_name
    if result.returncode != 0:
        log_hint = f" Full log: {log_path}." if log_path is not None else ""
        raise RuntimeError(
            f"Harbor exited {result.returncode}. Partial artifacts, if any: {job_dir}.{log_hint}"
        )
    return load_harbor_run(job_dir)


def load_harbor_run(job_dir: Path) -> HarborRun:
    job_dir = job_dir.resolve()
    job_result = _read_json(job_dir / "result.json")
    if not isinstance(job_result, dict):
        raise ValueError(f"missing or unreadable Harbor job result: {job_dir / 'result.json'}")
    trial_results = job_result.get("trial_results")
    candidates = trial_results if isinstance(trial_results, list) else []
    trial_dir: Path | None = None
    if len(candidates) == 1 and isinstance(candidates[0], dict):
        trial_result = candidates[0]
    else:
        result_paths = sorted(job_dir.glob("*/result.json"))
        child_results = [
            (path.parent, value)
            for path in result_paths
            if isinstance((value := _read_json(path)), dict)
        ]
        if len(child_results) != 1:
            raise ValueError(f"expected exactly one trial in {job_dir}")
        trial_dir, trial_result = child_results[0]

    trial_uri = trial_result.get("trial_uri")
    if isinstance(trial_uri, str) and trial_uri.startswith("file://"):
        from urllib.parse import unquote, urlparse

        trial_dir = Path(unquote(urlparse(trial_uri).path))
    if trial_dir is None or not trial_dir.is_dir():
        trial_name = trial_result.get("trial_name")
        candidate = job_dir / str(trial_name)
        if not candidate.is_dir():
            raise ValueError(f"cannot locate Harbor trial artifacts for {job_dir}")
        trial_dir = candidate
    return HarborRun(job_dir, trial_dir, job_result, trial_result)


def validation_result(task: Task, base: HarborRun, oracle: HarborRun) -> dict[str, Any]:
    base_rewards = base.rewards
    gold_rewards = oracle.rewards
    checks = {
        "base_f2p_fails": float(base_rewards.get("fail_to_pass", 0)) == 0,
        "base_p2p_passes": float(base_rewards.get("pass_to_pass", 0)) >= 1,
        "gold_f2p_passes": float(gold_rewards.get("fail_to_pass", 0)) >= 1,
        "gold_f2p_deterministic": float(gold_rewards.get("deterministic", 0)) >= 1,
        "gold_p2p_passes": float(gold_rewards.get("pass_to_pass", 0)) >= 1,
        "gold_patch_applies": float(gold_rewards.get("patch_applied", 0)) >= 1,
    }
    infrastructure_errors = {}
    setup_failures = {}
    for name, run in (("base", base), ("oracle", oracle)):
        exc = run.exception
        if exc is not None:
            infrastructure_errors[name] = (
                f"{exc.get('exception_type', 'Harbor error')}: "
                f"{exc.get('exception_message', '')}".rstrip()
            )
        if (
            float(run.rewards.get("patch_applied", 1)) >= 1
            and float(run.rewards.get("setup_completed", 1)) == 0
        ):
            setup_failures[name] = _setup_failure_signature(run)
    return {
        "result_schema_version": "harbor-1",
        "run_id": f"{base.trial_result.get('id')}+{oracle.trial_result.get('id')}",
        "run_kind": "validation",
        "task_id": task.task_id,
        "valid": all(checks.values()),
        "checks": checks,
        **({"infrastructure_errors": infrastructure_errors} if infrastructure_errors else {}),
        **({"setup_failures": setup_failures} if setup_failures else {}),
        "task_fingerprints": task.evaluation_fingerprints,
        "harbor": {
            "version_range": HARBOR_VERSION_RANGE,
            "base_job_dir": str(base.job_dir),
            "oracle_job_dir": str(oracle.job_dir),
            "base_trial_dir": str(base.trial_dir),
            "oracle_trial_dir": str(oracle.trial_dir),
        },
        "base_rewards": base_rewards,
        "gold_rewards": gold_rewards,
        "duration_s": _duration_seconds(
            base.trial_result.get("started_at"), oracle.trial_result.get("finished_at")
        ),
        "started_at": base.trial_result.get("started_at"),
        "finished_at": oracle.trial_result.get("finished_at"),
    }


def _write_harbor_task(
    root: Path,
    task: Task,
    local_repo: Path,
    task_name: str,
    package_profile: PackageManagerProfile | None,
) -> None:
    environment = root / "environment"
    solution = root / "solution"
    tests = root / "tests"
    environment.mkdir(parents=True)
    solution.mkdir()
    tests.mkdir()

    snapshot = _git_archive(local_repo, task.base_commit)
    (environment / "repo.tar.gz").write_bytes(snapshot)
    (tests / "repo.tar.gz").write_bytes(snapshot)
    (solution / "gold.patch").write_text(task.gold_patch)
    (tests / "test.patch").write_text(task.test_patch)
    (root / "instruction.md").write_text(task.prompt.rstrip() + "\n")
    (solution / "solve.sh").write_text(_solution_script(task))
    (tests / "test.sh").write_text(_test_script(task))
    (environment / "Dockerfile").write_text(_environment_dockerfile(task, package_profile))
    (tests / "Dockerfile").write_text(_verifier_dockerfile(task, package_profile))
    os.chmod(solution / "solve.sh", 0o755)
    os.chmod(tests / "test.sh", 0o755)
    (root / "task.toml").write_text(_task_toml(task, task_name))
    (root / GENERATED_MANIFEST).write_text(
        json.dumps(
            {
                "generator": "selfbench",
                "harbor_schema_version": HARBOR_SCHEMA_VERSION,
                "harbor_version_range": HARBOR_VERSION_RANGE,
                "environment_compiler_revision": ENVIRONMENT_COMPILER_REVISION,
                "task_id": task.task_id,
                "package_manager": package_profile.specifier if package_profile else None,
                "package_manager_profile": _profile_manifest_value(package_profile),
                "task_fingerprints": task.evaluation_fingerprints,
                "generated_at": datetime.now(UTC).isoformat(),
            },
            indent=2,
        )
        + "\n"
    )


def _task_toml(task: Task, task_name: str) -> str:
    metadata = {
        "selfbench_task_id": task.task_id,
        "repo": task.repo,
        "base_commit": task.base_commit,
        "workdir": task.workdir,
        "prompt_sha256": task.prompt_sha256,
        "definition_sha256": task.evaluation_fingerprints["definition_sha256"],
        "environment_compiler_revision": ENVIRONMENT_COMPILER_REVISION,
    }
    if task.source_pr is not None:
        metadata["source_pr"] = task.source_pr
    lines = [
        f'schema_version = "{HARBOR_SCHEMA_VERSION}"',
        'artifacts = ["/opt/selfbench/agent.patch"]',
        "",
        "[task]",
        f"name = {_toml_string(task_name)}",
        'version = "1.0.0"',
        f"description = {_toml_string(f'Reproduce {task.task_id} from its authentic engineer request.')} ",
        'keywords = ["software-engineering", "private-swe", "selfbench"]',
        "",
        "[metadata]",
        *[f"{key} = {_toml_value(value)}" for key, value in metadata.items()],
        "",
        # Phase-scoped network policy: the environment baseline below stays
        # reachable so Harbor can install the coding agent, but the agent's
        # working phase only reaches its model provider and the verifier reaches
        # nothing. Without this an agent clones the upstream repository or
        # downloads the source PR diff instead of implementing the change.
        "[agent]",
        f"timeout_sec = {float(task.timeout_agent)}",
        'user = "agent"',
        f"network_mode = {_toml_string(task.agent_network_mode)}",
        *(
            [f"allowed_hosts = {json.dumps(task.agent_allowed_hosts)}"]
            if task.agent_network_mode == "allowlist"
            else []
        ),
        "",
        "[verifier]",
        f"timeout_sec = {float(task.timeout_tests + task.timeout_setup)}",
        'user = "root"',
        'environment_mode = "separate"',
        f"network_mode = {_toml_string(task.verifier_network_mode)}",
        "",
        "[[verifier.collect]]",
        'service = "main"',
        'user = "root"',
        f"timeout_sec = {float(min(task.timeout_tests, 300))}",
        'command = "git --git-dir=/opt/selfbench/base.git --work-tree=/app add -A && git --git-dir=/opt/selfbench/base.git --work-tree=/app diff --cached --binary HEAD > /opt/selfbench/agent.patch"',
        "",
        "[environment]",
        f'network_mode = {_toml_string(task.network_mode)}',
        f"build_timeout_sec = {float(task.timeout_setup + 600)}",
        f"cpus = {task.cpus}",
        f"memory_mb = {task.memory_mb}",
        f"storage_mb = {task.storage_mb}",
        "",
        "[verifier.environment]",
        f'network_mode = {_toml_string(task.network_mode)}',
        f"build_timeout_sec = {float(task.timeout_setup + 600)}",
        f"cpus = {task.cpus}",
        f"memory_mb = {task.memory_mb}",
        f"storage_mb = {task.storage_mb}",
        "",
    ]
    return "\n".join(lines)


_TOOLCHAIN_LAYERS = {
    "uv": (
        "RUN curl -LsSf https://astral.sh/uv/install.sh \\\n"
        "    | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh"
    ),
    "go": (
        'RUN arch="$(dpkg --print-architecture)" \\\n'
        f'    && curl -fsSL "https://go.dev/dl/go{_GO_VERSION}.linux-${{arch}}.tar.gz" \\\n'
        "    | tar -C /usr/local -xz"
    ),
    "node": (
        'RUN arch="$(dpkg --print-architecture)" \\\n'
        "    && case \"$arch\" in \\\n"
        "        arm64) node_arch=arm64 ;; \\\n"
        "        amd64) node_arch=x64 ;; \\\n"
        '        *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \\\n'
        "    esac \\\n"
        f'    && curl -fsSL "https://nodejs.org/dist/v{_NODE_VERSION}/node-v{_NODE_VERSION}-linux-${{node_arch}}.tar.xz" \\\n'
        "    | tar -C /usr/local --strip-components=1 -xJ"
    ),
    "python": (
        f"RUN uv python install {_PYTHON_VERSIONS} \\\n"
        "    && ln -sf /usr/local/bin/python3.12 /usr/local/bin/python3 \\\n"
        "    && ln -sf /usr/local/bin/python3.12 /usr/local/bin/python \\\n"
        "    && chmod -R a+rX /usr/local/share/uv/python"
    ),
    "rust": (
        "RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \\\n"
        f"    | env RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo sh -s -- \\\n"
        f"        -y --no-modify-path --profile minimal --default-toolchain {_RUST_VERSION} \\\n"
        "    && chmod -R a+w /usr/local/cargo"
    ),
}


def _bun_layer(version: str) -> str:
    """Install one exact Bun release from its checksum-published release assets."""
    return f'''RUN arch="$(dpkg --print-architecture)" \\
    && case "$arch" in \\
        arm64) bun_arch=aarch64 ;; \\
        amd64) bun_arch=x64 ;; \\
        *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \\
    esac \\
    && bun_asset="bun-linux-${{bun_arch}}.zip" \\
    && bun_url="https://github.com/oven-sh/bun/releases/download/bun-v{version}" \\
    && curl -fsSL "$bun_url/SHASUMS256.txt" -o /tmp/bun-shasums.txt \\
    && expected="$(awk -v asset="$bun_asset" '$2 == asset {{print $1}}' /tmp/bun-shasums.txt)" \\
    && test -n "$expected" \\
    && curl -fsSL "$bun_url/$bun_asset" -o /tmp/bun.zip \\
    && printf '%s  %s\\n' "$expected" /tmp/bun.zip | sha256sum -c - \\
    && unzip -q /tmp/bun.zip -d /tmp/bun \\
    && install -m 0755 "/tmp/bun/bun-linux-${{bun_arch}}/bun" /usr/local/bin/bun \\
    && rm -rf /tmp/bun /tmp/bun.zip /tmp/bun-shasums.txt \\
    && test "$(bun --version)" = {shlex.quote(version)}'''


def _toolchain_layers(
    names: list[str] | None = None,
    package_profile: PackageManagerProfile | None = None,
) -> str:
    """Install deterministic toolchains and the snapshot's native JS manager.

    ``PATH`` extends the image default instead of replacing it, so system
    binaries such as ``useradd`` in ``/usr/sbin`` stay reachable. Toolchains go
    to ``/usr/local`` so the unprivileged agent user can run them too.
    """
    resolved = resolve_toolchains(names)
    layers = "\n".join(
        _package_manager_toolchain_layer(name, package_profile)
        for name in resolved
    )
    return f"""FROM {_BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \\
    UV_LINK_MODE=copy \\
    UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python \\
    UV_PYTHON_BIN_DIR=/usr/local/bin \\
    RUSTUP_HOME=/usr/local/rustup \\
    CARGO_HOME=/usr/local/cargo \\
    PATH=/usr/local/go/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin
RUN apt-get update && apt-get install -y --no-install-recommends \\
    bash build-essential ca-certificates curl git jq passwd pkg-config unzip xz-utils \\
    && rm -rf /var/lib/apt/lists/*
{layers}
"""


def _package_manager_toolchain_layer(
    name: str,
    package_profile: PackageManagerProfile | None,
) -> str:
    """Return a selected toolchain, substituting a snapshot-pinned JS manager."""
    if name == "bun":
        return _bun_layer(
            package_profile.version
            if package_profile is not None and package_profile.manager == "bun"
            else _BUN_VERSION
        )
    if name == "node" and package_profile is not None:
        if package_profile.manager == "npm":
            return _TOOLCHAIN_LAYERS[name] + "\n" + _npm_layer(package_profile.version)
        if package_profile.manager in {"pnpm", "yarn"}:
            return _TOOLCHAIN_LAYERS[name] + "\n" + _corepack_layer(package_profile)
    return _TOOLCHAIN_LAYERS[name]


def _corepack_layer(profile: PackageManagerProfile) -> str:
    """Persist an exact pnpm or Yarn release using Corepack's supported path."""
    return f"""ENV COREPACK_HOME=/usr/local/share/corepack \\
    COREPACK_DEFAULT_TO_LATEST=0
RUN mkdir -p "$COREPACK_HOME" /usr/local/share/corepack/bin \\
    && corepack enable --install-directory /usr/local/share/corepack/bin \\
    && corepack install --global {shlex.quote(profile.specifier)} \\
    && /usr/local/share/corepack/bin/{shlex.quote(profile.manager)} --version \\
    && test "$(/usr/local/share/corepack/bin/{shlex.quote(profile.manager)} --version)" = {shlex.quote(profile.version)} \\
    && chmod -R a+rX "$COREPACK_HOME"
ENV PATH=/usr/local/share/corepack/bin:$PATH
"""


def _npm_layer(version: str) -> str:
    """Install an exact npm release without pretending Corepack manages it."""
    if version == _NODE_NPM_VERSION:
        return f"""RUN test "$(npm --version)" = {shlex.quote(version)}
"""
    return f"""RUN mkdir -p /usr/local/share/selfbench-npm \\
    && npm install --global --prefix /usr/local/share/selfbench-npm {shlex.quote(f'npm@{version}')} \\
    && /usr/local/share/selfbench-npm/bin/npm --version \\
    && test "$(/usr/local/share/selfbench-npm/bin/npm --version)" = {shlex.quote(version)}
ENV PATH=/usr/local/share/selfbench-npm/bin:$PATH
"""


def _repo_layers(task: Task) -> str:
    """Unpack the history-free snapshot and run the task's own setup command."""
    return f"""COPY repo.tar.gz /tmp/repo.tar.gz
RUN mkdir -p /app && tar -xzf /tmp/repo.tar.gz -C /app && rm /tmp/repo.tar.gz \\
    && git -C /app init -q \\
    && git -C /app config user.email selfbench@local \\
    && git -C /app config user.name selfbench \\
    && git -C /app add -A \\
    && git -C /app commit -qm base
{_docker_run(task.setup_cmd, f"/app/{task.workdir}")}
"""


def _environment_dockerfile(
    task: Task,
    package_profile: PackageManagerProfile | None = None,
) -> str:
    """Agent-facing image: no gold patch, no held-out tests, no provenance.

    ``/opt/selfbench/base.git`` is a root-only copy of the pristine base repo.
    The collect hook diffs against it, so an agent that rewrites ``/app/.git``
    cannot disguise what it actually changed.
    """
    return f"""{_toolchain_layers(task.toolchains, package_profile)}
RUN useradd --create-home --shell /bin/bash agent
{_repo_layers(task)}
RUN git -C /app reset --hard -q HEAD \\
    && git -C /app clean -fdq \\
    && mkdir -p /opt/selfbench \\
    && cp -a /app/.git /opt/selfbench/base.git \\
    && chown -R agent:agent /app /home/agent \\
    && chown -R root:root /opt/selfbench \\
    && chmod 700 /opt/selfbench
USER agent
WORKDIR /app
"""


def _verifier_dockerfile(
    task: Task,
    package_profile: PackageManagerProfile | None = None,
) -> str:
    """Verifier image: holds the held-out tests the agent never sees."""
    return f"""{_toolchain_layers(task.toolchains, package_profile)}
{_repo_layers(task)}
RUN mkdir -p /opt/selfbench && chmod 700 /opt/selfbench
COPY . /tests/
RUN chmod +x /tests/test.sh
WORKDIR /app
"""


def _solution_script(task: Task) -> str:
    return """#!/bin/bash
set -euo pipefail
git -C /app apply --binary --whitespace=nowarn /solution/gold.patch
"""


def _test_script(task: Task) -> str:
    exclusions = " ".join(
        f"--exclude={shlex.quote(path.rstrip('/'))} --exclude={shlex.quote(path.rstrip('/') + '/*')}"
        for path in task.test_paths
    )
    protected = " ".join(shlex.quote(path) for path in task.test_paths)
    workdir = shlex.quote(f"/app/{task.workdir}")
    f2p = _test_command(task, task.fail_to_pass)
    p2p = _test_command(task, task.pass_to_pass) if task.pass_to_pass else "true"
    setup = task.setup_cmd
    return f"""#!/bin/bash
set -uo pipefail
mkdir -p /logs/verifier
patch_applied=1
fail_to_pass=0
pass_to_pass=0
deterministic=0
setup_completed=0

if [ ! -f /opt/selfbench/agent.patch ]; then
  echo "Harbor did not transfer the captured agent patch" >&2
  patch_applied=0
elif [ -s /opt/selfbench/agent.patch ]; then
  git -C /app apply --binary --whitespace=nowarn {exclusions} /opt/selfbench/agent.patch || patch_applied=0
fi

if [ "$patch_applied" -eq 1 ]; then
  git -C /app restore --source=HEAD --staged --worktree -- {protected} 2>/dev/null || true
  git -C /app clean -fd -- {protected} >/dev/null 2>&1 || true
  git -C /app apply --binary --whitespace=nowarn /tests/test.patch || patch_applied=0
fi

if [ "$patch_applied" -eq 1 ]; then
  cd {workdir}
  if bash -lc {shlex.quote(setup)}; then
    setup_completed=1
    if bash -lc {shlex.quote(f2p)}; then
      fail_to_pass=1
      if bash -lc {shlex.quote(f2p)}; then deterministic=1; fi
    fi
    if bash -lc {shlex.quote(p2p)}; then pass_to_pass=1; fi
  fi
fi

reward=0
if [ "$patch_applied" -eq 1 ] && [ "$fail_to_pass" -eq 1 ] && [ "$pass_to_pass" -eq 1 ] && [ "$deterministic" -eq 1 ]; then
  reward=1
fi
cat > /logs/verifier/reward.json <<EOF
{{"reward": $reward, "patch_applied": $patch_applied, "fail_to_pass": $fail_to_pass, "pass_to_pass": $pass_to_pass, "deterministic": $deterministic, "setup_completed": $setup_completed}}
EOF
exit 0
"""


def _test_command(task: Task, tests: list[str]) -> str:
    selected = " ".join(shlex.quote(test) for test in tests)
    return task.test_cmd.format(tests=selected)


def _docker_run(command: str, workdir: str) -> str:
    return (
        "RUN --mount=type=cache,target=/root/.cache "
        f"cd {shlex.quote(workdir)} && bash -lc {shlex.quote(command)}"
    )


def _setup_failure_signature(run: HarborRun) -> str:
    """Return a stable, short signature for a verifier setup failure."""
    output = run.trial_dir / "verifier" / "test-stdout.txt"
    if output.is_file():
        text = output.read_text(errors="replace")
        if match := re.search(r"\bERR_[A-Z0-9_]+\b", text):
            return match.group(0)
    return "setup command failed"


def _package_manager_profile(local_repo: Path, task: Task) -> PackageManagerProfile | None:
    """Resolve one native JS package manager from the exact task snapshot.

    A profile is intentionally stricter than package-manager discovery. A
    package manifest, a lockfile, and the explicit manager pin have to agree;
    otherwise the generated image would be making an unreviewable choice about
    how to install a repository. Repositories without any of that JS metadata
    retain the historical task behavior.
    """
    workdir = _snapshot_workdir(task.workdir)
    package_json_path = _snapshot_join(workdir, "package.json")
    package_json = _snapshot_file(local_repo, task.base_commit, package_json_path)
    lockfiles = {
        manager: tuple(
            (path, content)
            for filename in filenames
            if (content := _snapshot_file(
                local_repo,
                task.base_commit,
                path := _snapshot_join(workdir, filename),
            )) is not None
        )
        for manager, filenames in _JS_LOCKFILES.items()
    }
    managers_with_locks = {manager for manager, files in lockfiles.items() if files}

    if package_json is None and not managers_with_locks:
        return None
    display_workdir = task.workdir
    if package_json is None:
        found = ", ".join(sorted(_lockfile_paths(lockfiles)))
        raise ValueError(
            f"JS lockfile(s) found at {display_workdir} without package.json: {found}"
        )
    try:
        manifest = json.loads(package_json)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid package.json at {display_workdir}: {exc.msg}") from exc
    if not isinstance(manifest, dict):
        raise ValueError(f"package.json at {display_workdir} must contain an object")

    raw_specifier = manifest.get("packageManager")
    if raw_specifier is None and not managers_with_locks:
        # A generic package.json without native-manager metadata is an old task,
        # not a reason to infer one. Keep its historical image behavior.
        return None
    if not isinstance(raw_specifier, str) or not raw_specifier:
        raise ValueError(
            f"package.json at {display_workdir} requires an exact packageManager pin "
            "when JS metadata is present"
        )
    manager, separator, declared_version = raw_specifier.partition("@")
    version = declared_version.partition("+")[0]
    if (
        manager not in _SUPPORTED_JS_MANAGERS
        or not separator
        or not _EXACT_PACKAGE_MANAGER_VERSION.fullmatch(declared_version)
        or (manager in {"npm", "bun"} and "+" in declared_version)
    ):
        supported = ", ".join(sorted(_SUPPORTED_JS_MANAGERS))
        raise ValueError(
            f"package.json at {display_workdir} has unsupported packageManager "
            f"{raw_specifier!r}; require one of {supported} with an exact x.y.z version"
        )
    if not managers_with_locks:
        raise ValueError(
            f"package.json at {display_workdir} declares {raw_specifier} but has no "
            f"{manager} lockfile"
        )
    found_lockfiles = sorted(_lockfile_paths(lockfiles))
    if len(found_lockfiles) > 1:
        raise ValueError(
            f"conflicting JS lockfiles at {display_workdir}: {', '.join(found_lockfiles)}"
        )
    if managers_with_locks != {manager}:
        raise ValueError(
            f"package manager {manager} from package.json at {display_workdir} conflicts "
            f"with lockfile(s): {', '.join(found_lockfiles)}"
        )

    profile = PackageManagerProfile(
        manager=manager,
        version=version,
        specifier=raw_specifier,
        package_json_sha256=_sha256(package_json),
        lockfiles=tuple(
            (path, _sha256(content))
            for path, content in lockfiles[manager]
        ),
    )
    _validate_profile_toolchains(task, profile)
    _validate_profile_setup_command(task, profile)
    return profile


def _snapshot_workdir(workdir: str) -> str:
    path = Path(workdir)
    if not workdir or path.is_absolute() or ".." in path.parts:
        raise ValueError(f"workdir must stay inside the repository: {workdir!r}")
    return "" if path == Path(".") else path.as_posix().strip("/")


def _snapshot_join(workdir: str, filename: str) -> str:
    return f"{workdir}/{filename}" if workdir else filename


def _snapshot_file(local_repo: Path, commit: str, path: str) -> bytes | None:
    result = subprocess.run(
        ["git", "-C", str(local_repo), "show", f"{commit}:{path}"],
        capture_output=True,
        check=False,
    )
    return result.stdout if result.returncode == 0 else None


def _lockfile_paths(lockfiles: dict[str, tuple[tuple[str, bytes], ...]]) -> list[str]:
    return [path for files in lockfiles.values() for path, _ in files]


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _profile_manifest_value(profile: PackageManagerProfile | None) -> dict[str, object] | None:
    return profile.as_dict() if profile is not None else None


def _validate_profile_toolchains(task: Task, profile: PackageManagerProfile) -> None:
    selected = set(resolve_toolchains(task.toolchains))
    required = "bun" if profile.manager == "bun" else "node"
    if required not in selected:
        raise ValueError(
            f"{profile.specifier} at {task.workdir} requires the {required!r} toolchain; "
            "select it in task.json"
        )


def _validate_profile_setup_command(task: Task, profile: PackageManagerProfile) -> None:
    """Reject only unambiguous manager conflicts and mutable native installs."""
    for manager, arguments in _setup_manager_invocations(task.setup_cmd):
        if manager != profile.manager:
            raise ValueError(
                f"setup_cmd invokes {manager}, but package.json at {task.workdir} declares "
                f"{profile.specifier}"
            )
        _validate_immutable_install(manager, arguments)


def _setup_manager_invocations(command: str) -> list[tuple[str, str]]:
    """Find direct manager commands at shell command boundaries.

    This deliberately avoids trying to interpret arbitrary shell programs. It
    catches commands that plainly choose a manager while preserving complex,
    task-specific setup steps for preflight to execute.
    """
    pattern = re.compile(
        r"(?:^|&&|\|\||;|\n)\s*"
        r"(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]+\s+)*"
        r"(?P<command>npm|npx|pnpm|pnpx|yarn|yarnpkg|bun|bunx)\b"
        r"(?P<arguments>[^\n;&|]*)"
    )
    aliases = {
        "npm": "npm",
        "npx": "npm",
        "pnpm": "pnpm",
        "pnpx": "pnpm",
        "yarn": "yarn",
        "yarnpkg": "yarn",
        "bun": "bun",
        "bunx": "bun",
    }
    return [
        (aliases[match.group("command")], match.group("arguments").strip())
        for match in pattern.finditer(command)
    ]


def _validate_immutable_install(manager: str, arguments: str) -> None:
    """Reject clear mutable dependency installs, not unrelated manager commands."""
    try:
        words = shlex.split(arguments)
    except ValueError:
        # Shell syntax itself is left to the actual task setup command.
        return
    if not words:
        return
    subcommand = words[0]
    flags = set(words[1:])
    if manager == "npm":
        global_install = {"-g", "--global", "--location=global"}.intersection(flags)
        if "--location" in flags:
            location = words.index("--location") + 1
            if location < len(words) and words[location] == "global":
                global_install = {"--location global"}
        if subcommand == "install" and not global_install:
            raise ValueError("setup_cmd uses mutable npm install; use npm ci with package-lock.json")
        return
    if manager == "pnpm" and subcommand in {"install", "i"}:
        if not any(flag in {"--frozen-lockfile", "--frozen-lockfile=true"} for flag in flags):
            raise ValueError(
                "setup_cmd uses mutable pnpm install; add --frozen-lockfile"
            )
        return
    if manager == "yarn" and subcommand == "install":
        if not {"--immutable", "--frozen-lockfile"}.intersection(flags):
            raise ValueError(
                "setup_cmd uses mutable yarn install; add --immutable"
            )
        return
    if manager == "bun" and subcommand == "install":
        if not any(flag in {"--frozen-lockfile", "--frozen-lockfile=true"} for flag in flags):
            raise ValueError(
                "setup_cmd uses mutable bun install; add --frozen-lockfile"
            )


def _git_archive(local_repo: Path, commit: str) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(local_repo), "archive", "--format=tar.gz", commit],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode(errors="replace").strip())
    return result.stdout


def _check_commit(local_repo: Path, commit: str) -> None:
    if not (local_repo / ".git").exists():
        # Worktrees have a .git file.
        if not (local_repo / ".git").is_file():
            raise ValueError(f"not a Git repository: {local_repo}")
    result = subprocess.run(
        ["git", "-C", str(local_repo), "cat-file", "-e", f"{commit}^{{commit}}"],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise ValueError(f"base commit {commit} is not available in {local_repo}")


def _require_harbor() -> Path:
    environment_harbor = Path(sys.executable).parent / "harbor"
    path_harbor = shutil.which("harbor")
    harbor = environment_harbor if environment_harbor.is_file() else Path(path_harbor) if path_harbor else None
    if harbor is None:
        raise RuntimeError(f"Harbor {HARBOR_VERSION_RANGE} is required; run uv sync")
    result = subprocess.run([str(harbor), "--version"], text=True, capture_output=True, check=False)
    version = result.stdout.strip() or result.stderr.strip()
    match = version.rsplit(" ", 1)[-1]
    version_match = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:\.dev(\d+))?$", match)
    if version_match is None:
        raise RuntimeError(f"could not determine Harbor version from: {version}")
    major, minor, patch, dev = version_match.groups()
    installed_version = (int(major), int(minor), int(patch))
    if not (installed_version[:2] == (0, 20) and installed_version >= (0, 20, 1)):
        raise RuntimeError(f"Harbor {HARBOR_VERSION_RANGE} is required, found {version}")
    if dev is not None and int(dev) < 202607200228:
        raise RuntimeError(f"Harbor {HARBOR_VERSION_RANGE} is required, found {version}")
    return harbor


def _duration_seconds(started_at: object, finished_at: object) -> float | None:
    if not isinstance(started_at, str) or not isinstance(finished_at, str):
        return None
    try:
        started = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        finished = datetime.fromisoformat(finished_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    return round((finished - started).total_seconds(), 1)


def _harbor_name(value: str) -> str:
    normalized = "".join(char.lower() if char.isalnum() else "-" for char in value)
    normalized = "-".join(part for part in normalized.split("-") if part)
    if not normalized:
        raise ValueError(f"cannot derive a Harbor package name from {value!r}")
    return normalized


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _toml_value(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return _toml_string(str(value))


def _read_json(path: Path) -> object | None:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None
