"""Modal sandbox plumbing: image, snapshot upload, command execution."""

from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import modal

APP_NAME = "make-your-swebench"
PI_VERSION = "0.75.0"
PYTHON_VERSION = "3.12"
NODE_MAJOR_VERSION = "22"
GO_VERSION = "1.25.0"
UV_VERSION = "0.11.3"
BUN_VERSION = "1.3.13"
REPO_DIR = "/work/repo"
OUT_DIR = "/out"

# Keys pi needs for the providers we run. Only keys present locally are forwarded.
PROVIDER_ENV_KEYS = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "FIREWORKS_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
]


def build_image() -> modal.Image:
    return (
        modal.Image.debian_slim(python_version=PYTHON_VERSION)
        .apt_install("git", "curl", "ca-certificates", "build-essential", "unzip")
        .run_commands(
            f"curl -fsSL https://deb.nodesource.com/setup_{NODE_MAJOR_VERSION}.x | bash -",
            "apt-get install -y nodejs",
            f"npm install -g @mupt-ai/pi-coding-agent@{PI_VERSION}",
            f"curl -LsSf https://astral.sh/uv/{UV_VERSION}/install.sh "
            "| env UV_NO_MODIFY_PATH=1 sh",
            f"curl -fsSL https://go.dev/dl/go{GO_VERSION}.linux-amd64.tar.gz | tar -C /usr/local -xz",
            f"curl -fsSL https://bun.sh/install | bash -s 'bun-v{BUN_VERSION}'",
        )
        .env({"PATH": "/root/.local/bin:/root/.bun/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin"})
    )


def runtime_manifest() -> dict[str, str]:
    return {
        "python": PYTHON_VERSION,
        "node_major": NODE_MAJOR_VERSION,
        "go": GO_VERSION,
        "uv": UV_VERSION,
        "bun": BUN_VERSION,
        "pi": PI_VERSION,
        "executor": "modal-sandbox",
    }


@dataclass
class ExecResult:
    exit_code: int
    output: str  # interleaved stdout+stderr


class TaskSandbox:
    """Fresh sandbox primitive used for one validation, agent, or grading phase.

    Repository snapshots are uploaded rather than cloned, so they have no
    origin remote, credentials, or Git history past the base commit.
    """

    def __init__(self, verbose: bool = True):
        self.verbose = verbose
        app = modal.App.lookup(APP_NAME, create_if_missing=True)
        provider_env = {k: os.environ[k] for k in PROVIDER_ENV_KEYS if k in os.environ}
        self.provider_secret = modal.Secret.from_dict(provider_env) if provider_env else None
        self.sb = modal.Sandbox.create(
            app=app,
            image=build_image(),
            timeout=3 * 60 * 60,
            cpu=4,
            memory=8192,
        )

    def close(self) -> None:
        self.sb.terminate()

    def __enter__(self) -> "TaskSandbox":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def log(self, msg: str) -> None:
        if self.verbose:
            print(msg, file=sys.stderr, flush=True)

    def put_file(self, remote_path: str, data: bytes) -> None:
        self.sb.filesystem.write_bytes(data, remote_path)

    def get_file(self, remote_path: str) -> bytes:
        return self.sb.filesystem.read_bytes(remote_path)

    def exec(
        self,
        cmd: str,
        workdir: str = REPO_DIR,
        timeout: int = 600,
        *,
        provider_secrets: bool = False,
    ) -> ExecResult:
        """Run a shell command, streaming output to stderr."""
        self.log(f"[sandbox] $ {cmd}")
        secrets = [self.provider_secret] if provider_secrets and self.provider_secret else None
        p = self.sb.exec(
            "bash", "-c", cmd, workdir=workdir, timeout=timeout,
            secrets=secrets,
            stdout=modal.io_streams.StreamType.PIPE,
            stderr=modal.io_streams.StreamType.STDOUT,
        )
        chunks: list[str] = []
        for line in p.stdout:
            chunks.append(line)
            if self.verbose:
                sys.stderr.write(line)
                sys.stderr.flush()
        exit_code = p.wait()
        return ExecResult(exit_code=exit_code, output="".join(chunks))

    def exec_checked(
        self,
        cmd: str,
        *,
        action: str,
        workdir: str = REPO_DIR,
        timeout: int = 600,
        provider_secrets: bool = False,
    ) -> ExecResult:
        result = self.exec(
            cmd,
            workdir=workdir,
            timeout=timeout,
            provider_secrets=provider_secrets,
        )
        if result.exit_code != 0:
            raise RuntimeError(
                f"{action} failed (exit {result.exit_code}):\n{result.output[-3000:]}"
            )
        return result

    def upload_snapshot(self, local_repo: Path, base_commit: str) -> None:
        """git-archive the repo at base_commit and unpack it in the sandbox,
        then re-init git so we can diff/reset. No history ships."""
        self.log(f"[local] archiving {local_repo} @ {base_commit[:12]}")
        tar = subprocess.run(
            ["git", "-C", str(local_repo), "archive", "--format=tar.gz", base_commit],
            check=True, capture_output=True,
        ).stdout
        self.exec_checked(
            f"mkdir -p {REPO_DIR} {OUT_DIR}",
            action="sandbox workspace creation",
            workdir="/",
        )
        self.put_file("/work/snapshot.tar.gz", tar)
        self.exec_checked(
            f"tar -xzf /work/snapshot.tar.gz -C {REPO_DIR}",
            action="repository snapshot extraction",
            workdir="/",
            timeout=300,
        )
        self.exec_checked(
            "git init -q && git config user.email mysb@local && git config user.name mysb "
            "&& git add -A && git commit -qm base",
            action="repository snapshot initialization",
            timeout=300,
        )
