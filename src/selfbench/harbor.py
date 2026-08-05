"""Harbor-shaped environments for selfbench tasks.

selfbench owns authoring, provenance, quality audit, and review. This module owns
only the environment an eval executes in: it compiles a selfbench task into a
Harbor-format task directory and runs it on Harbor, which is the default runtime.
The compiled environment is sealed, so authoring inputs such as source
transcripts, task.json, and the gold patch never reach the agent.
"""

from __future__ import annotations

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
ENVIRONMENT_COMPILER_REVISION = 4
_BASE_IMAGE = "ubuntu:24.04"
_GO_VERSION = "1.25.0"
_RUST_VERSION = "1.90.0"
_PYTHON_VERSIONS = "3.12 3.11 3.13"
_NODE_VERSION = "22.14.0"
GENERATED_MANIFEST = ".selfbench-manifest.json"


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
    destination = output_root / task.task_id
    if destination.exists() and not overwrite:
        manifest = _read_json(destination / GENERATED_MANIFEST)
        if (
            isinstance(manifest, dict)
            and manifest.get("environment_compiler_revision") == ENVIRONMENT_COMPILER_REVISION
            and manifest.get("task_fingerprints") == task.evaluation_fingerprints
        ):
            return destination
        raise FileExistsError(
            f"{destination} already exists and is not current; pass --force to replace it"
        )

    output_root.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{task.task_id}-", dir=output_root))
    try:
        _write_harbor_task(staging, task, local_repo, task_name)
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
    for name, run in (("base", base), ("oracle", oracle)):
        exc = run.exception
        if exc is not None:
            infrastructure_errors[name] = (
                f"{exc.get('exception_type', 'Harbor error')}: "
                f"{exc.get('exception_message', '')}".rstrip()
            )
    return {
        "result_schema_version": "harbor-1",
        "run_id": f"{base.trial_result.get('id')}+{oracle.trial_result.get('id')}",
        "run_kind": "validation",
        "task_id": task.task_id,
        "valid": all(checks.values()),
        "checks": checks,
        **({"infrastructure_errors": infrastructure_errors} if infrastructure_errors else {}),
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


def _write_harbor_task(root: Path, task: Task, local_repo: Path, task_name: str) -> None:
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
    (environment / "Dockerfile").write_text(_environment_dockerfile(task))
    (tests / "Dockerfile").write_text(_verifier_dockerfile(task))
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
    "bun": "RUN curl -fsSL https://bun.sh/install | env BUN_INSTALL=/usr/local bash",
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


def _toolchain_layers(names: list[str] | None = None) -> str:
    """Install the deterministic toolchain shared by the agent and the verifier.

    ``PATH`` extends the image default instead of replacing it, so system
    binaries such as ``useradd`` in ``/usr/sbin`` stay reachable. Toolchains go
    to ``/usr/local`` so the unprivileged agent user can run them too.
    """
    layers = "\n".join(_TOOLCHAIN_LAYERS[name] for name in resolve_toolchains(names))
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


def _environment_dockerfile(task: Task) -> str:
    """Agent-facing image: no gold patch, no held-out tests, no provenance.

    ``/opt/selfbench/base.git`` is a root-only copy of the pristine base repo.
    The collect hook diffs against it, so an agent that rewrites ``/app/.git``
    cannot disguise what it actually changed.
    """
    return f"""{_toolchain_layers(task.toolchains)}
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


def _verifier_dockerfile(task: Task) -> str:
    """Verifier image: holds the held-out tests the agent never sees."""
    return f"""{_toolchain_layers(task.toolchains)}
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
{{"reward": $reward, "patch_applied": $patch_applied, "fail_to_pass": $fail_to_pass, "pass_to_pass": $pass_to_pass, "deterministic": $deterministic}}
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
