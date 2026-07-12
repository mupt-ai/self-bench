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
        modal.Image.debian_slim(python_version="3.12")
        .apt_install("git", "curl", "ca-certificates", "build-essential", "unzip")
        .run_commands(
            "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
            "apt-get install -y nodejs",
            f"npm install -g @mupt-ai/pi-coding-agent@{PI_VERSION}",
            "curl -LsSf https://astral.sh/uv/install.sh | sh",
            "curl -fsSL https://go.dev/dl/go1.25.0.linux-amd64.tar.gz | tar -C /usr/local -xz",
            "curl -fsSL https://bun.sh/install | bash",
        )
        .env({"PATH": "/root/.local/bin:/root/.bun/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin"})
    )


@dataclass
class ExecResult:
    exit_code: int
    output: str  # interleaved stdout+stderr


class TaskSandbox:
    """One sandbox per rollout. Repo snapshot is uploaded, never cloned:
    the sandbox has no origin remote, no credentials, and no git history
    past the base commit."""

    def __init__(self, verbose: bool = True):
        self.verbose = verbose
        app = modal.App.lookup(APP_NAME, create_if_missing=True)
        secret = modal.Secret.from_dict(
            {k: os.environ[k] for k in PROVIDER_ENV_KEYS if k in os.environ}
        )
        self.sb = modal.Sandbox.create(
            app=app,
            image=build_image(),
            secrets=[secret],
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

    def exec(self, cmd: str, workdir: str = REPO_DIR, timeout: int = 600) -> ExecResult:
        """Run a shell command, streaming output to stderr."""
        self.log(f"[sandbox] $ {cmd}")
        p = self.sb.exec(
            "bash", "-c", cmd, workdir=workdir, timeout=timeout,
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

    def upload_snapshot(self, local_repo: Path, base_commit: str) -> None:
        """git-archive the repo at base_commit and unpack it in the sandbox,
        then re-init git so we can diff/reset. No history ships."""
        self.log(f"[local] archiving {local_repo} @ {base_commit[:12]}")
        tar = subprocess.run(
            ["git", "-C", str(local_repo), "archive", "--format=tar.gz", base_commit],
            check=True, capture_output=True,
        ).stdout
        self.exec(f"mkdir -p {REPO_DIR} {OUT_DIR}", workdir="/")
        self.put_file("/work/snapshot.tar.gz", tar)
        self.exec(f"tar -xzf /work/snapshot.tar.gz -C {REPO_DIR}", workdir="/", timeout=300)
        self.exec(
            "git init -q && git config user.email mysb@local && git config user.name mysb "
            "&& git add -A && git commit -qm base",
            timeout=300,
        )
