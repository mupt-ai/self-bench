"""Local discovery parent for Modal generation fan-out."""

from __future__ import annotations

import os
import subprocess
from contextlib import ExitStack
from importlib.resources import as_file, files
from pathlib import Path

from .agent_input import extract_prompt
from .modal_generation import (
    GenerationManifest,
    ManifestError,
    load_generation_manifest,
)


def discover_generation_manifest(
    repo: Path,
    tasks_root: Path,
    output_path: Path,
    log_path: Path,
    *,
    run_id: str,
    target_count: int,
    reserve_count: int,
    profile: str,
    provider: str,
    model: str,
    thinking: str | None,
    pi_executable: str = "pi",
) -> GenerationManifest:
    """Run a read-only local Pi parent and return its validated candidate plan."""
    repo = repo.expanduser().resolve()
    tasks_root = tasks_root.expanduser().resolve()
    if not repo.is_dir():
        raise ManifestError(f"source repository does not exist: {repo}")
    if target_count < 1 or reserve_count < 0:
        raise ManifestError("target_count must be positive and reserve_count non-negative")
    repo_url = _git(repo, "remote", "get-url", "origin")
    source_commit = _remote_head(repo)
    expected_candidates = target_count + reserve_count
    prompt = _discovery_prompt(
        repo=repo,
        tasks_root=tasks_root,
        run_id=run_id,
        target_count=target_count,
        expected_candidates=expected_candidates,
        repo_url=repo_url,
        source_commit=source_commit,
        profile=profile,
        provider=provider,
        model=model,
        thinking=thinking,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.unlink(missing_ok=True)
    skill = files("selfbench").joinpath("skills/selfbench/SKILL.md")
    extension = files("selfbench").joinpath("extensions/modal_generation_plan.ts")
    with ExitStack() as stack:
        resolved_skill = stack.enter_context(as_file(skill))
        resolved_extension = stack.enter_context(as_file(extension))
        command = [
            pi_executable,
            "--skill",
            str(resolved_skill),
            "--extension",
            str(resolved_extension),
            "--provider",
            provider,
            "--model",
            model,
            "--mode",
            "json",
            "--no-session",
            "--no-approve",
            "--tools",
            "read,bash,grep,find,ls,submit_generation_plan",
        ]
        if thinking:
            command.extend(("--thinking", thinking))
        command.append(prompt)
        environment = os.environ.copy()
        environment["SELFBENCH_PLAN_OUTPUT"] = str(output_path)
        try:
            with log_path.open("wb") as log:
                result = subprocess.run(
                    command,
                    cwd=repo,
                    env=environment,
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    check=False,
                )
        except FileNotFoundError as exc:
            raise RuntimeError(f"Pi executable not found: {pi_executable}") from exc
    if result.returncode != 0:
        raise RuntimeError(f"parent discovery exited {result.returncode}; private log: {log_path}")
    if not output_path.is_file():
        raise RuntimeError(f"parent discovery did not submit a plan; private log: {log_path}")
    manifest = load_generation_manifest(output_path)
    _validate_parent_manifest(
        manifest,
        run_id=run_id,
        target_count=target_count,
        expected_candidates=expected_candidates,
        repo_url=repo_url,
        source_commit=source_commit,
        profile=profile,
        provider=provider,
        model=model,
        thinking=thinking,
    )
    _verify_candidate_commits(repo, manifest)
    return manifest


def _discovery_prompt(
    *,
    repo: Path,
    tasks_root: Path,
    run_id: str,
    target_count: int,
    expected_candidates: int,
    repo_url: str,
    source_commit: str,
    profile: str,
    provider: str,
    model: str,
    thinking: str | None,
) -> str:
    thinking_value = f'"thinking": "{thinking}",' if thinking else ""
    return f"""Act as the local parent for a SelfBench Modal generation run.

Perform only Step 1 candidate discovery from the loaded SelfBench skill. Do not author, validate,
audit, or modify task directories. You have local access specifically so you can search authentic
pre-implementation provenance in Pi, Claude Code, Codex, relaymux, issue, and journal sources.

Repository: {repo}
Existing and rejected task root: {tasks_root}
Difficulty profile: {profile}
Validated-task target: {target_count}
Ranked candidate count requested: {expected_candidates} ({target_count} active plus reserves)

Read every existing task.json and rejection before ranking. Inspect actual diffs and test design.
For each candidate, verify an authentic provenance source before including it. Prefer an exact local
session path with format/message index; use a URL only for an authentic pre-implementation issue or
request. Resolve the exact base commit and completed merge/squash commit. Exclude any candidate whose
setup, implementation/test separation, provenance, or reproducibility is already clearly non-viable.

Call submit_generation_plan exactly once with this fixed envelope:
- schema_version: 1
- run_id: {run_id}
- target_count: {target_count}
- source.repo_url: {repo_url}
- source.commit: {source_commit}
- agent: {{"provider": "{provider}", "model": "{model}", {thinking_value} "profile": "{profile}"}}
- workers: exactly {expected_candidates} entries if that many strong provenance-backed candidates exist,
  otherwise every viable candidate and no filler.

Each worker must target exactly one PR, use target_count 1, and have a stable worker_id such as pr-123.
Its request must briefly state why the implementation core is suitable and any setup/workdir facts the
child must verify. Put entries in descending rank order. After the tool call, stop."""


def _validate_parent_manifest(
    manifest: GenerationManifest,
    *,
    run_id: str,
    target_count: int,
    expected_candidates: int,
    repo_url: str,
    source_commit: str,
    profile: str,
    provider: str,
    model: str,
    thinking: str | None,
) -> None:
    expected = {
        "run_id": run_id,
        "target_count": target_count,
        "repo_url": repo_url,
        "source_commit": source_commit.lower(),
        "profile": profile,
        "provider": provider,
        "model": model,
        "thinking": thinking,
    }
    actual = {
        "run_id": manifest.run_id,
        "target_count": manifest.target_count,
        "repo_url": manifest.source_repo_url,
        "source_commit": manifest.source_commit,
        "profile": manifest.agent.profile,
        "provider": manifest.agent.provider,
        "model": manifest.agent.model,
        "thinking": manifest.agent.thinking,
    }
    if actual != expected:
        raise ManifestError("parent changed the fixed run envelope")
    if len(manifest.workers) > expected_candidates:
        raise ManifestError("parent returned more candidates than requested")
    if len(manifest.workers) < target_count:
        raise ManifestError(
            f"parent found only {len(manifest.workers)} viable candidates for target {target_count}"
        )
    source_prs: set[int] = set()
    for worker in manifest.workers:
        if len(worker.candidates) != 1 or worker.target_count != 1:
            raise ManifestError(f"parent worker {worker.worker_id} must contain exactly one candidate")
        if worker.source_pr is None or worker.source_pr in source_prs:
            raise ManifestError("parent workers must have unique positive source_pr values")
        source_prs.add(worker.source_pr)
        if worker.base_commit is None or worker.completed_commit is None:
            raise ManifestError(f"parent worker {worker.worker_id} is missing pinned commits")
        if worker.base_commit == worker.completed_commit:
            raise ManifestError(f"parent worker {worker.worker_id} has identical base and completed commits")
        if worker.provenance is None:
            raise ManifestError(f"parent worker {worker.worker_id} is missing authentic provenance")
        expected_pr_suffix = f"/pull/{worker.source_pr}"
        candidate_url = worker.candidates[0].rstrip("/")
        if not candidate_url.endswith(expected_pr_suffix):
            raise ManifestError(
                f"parent worker {worker.worker_id} candidate URL does not match source_pr"
            )
        if worker.provenance.get("kind") == "file":
            path = Path(str(worker.provenance["path"])).expanduser().resolve()
            source_format = str(worker.provenance.get("format", "auto"))
            message_index = int(worker.provenance.get("message_index", 0))
            try:
                extract_prompt(path, source_format=source_format, message_index=message_index)
            except (OSError, ValueError) as exc:
                raise ManifestError(
                    f"parent worker {worker.worker_id} provenance is unreadable: {exc}"
                ) from exc


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _remote_head(repo: Path) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), "ls-remote", "origin", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    )
    first_line = result.stdout.splitlines()[0] if result.stdout.splitlines() else ""
    commit, separator, ref = first_line.partition("\t")
    if not separator or ref != "HEAD" or len(commit) != 40:
        raise ManifestError("could not resolve the source repository's remote HEAD")
    return commit.lower()


def _verify_candidate_commits(repo: Path, manifest: GenerationManifest) -> None:
    commits = {
        commit
        for worker in manifest.workers
        for commit in (worker.base_commit, worker.completed_commit)
        if commit is not None
    }
    for commit in commits:
        exists = subprocess.run(
            ["git", "-C", str(repo), "cat-file", "-e", f"{commit}^{{commit}}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        ).returncode == 0
        if not exists:
            fetched = subprocess.run(
                ["git", "-C", str(repo), "fetch", "--quiet", "origin", commit],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            if fetched.returncode != 0:
                raise ManifestError(f"candidate commit is not fetchable from origin: {commit}")
    for worker in manifest.workers:
        assert worker.base_commit is not None
        assert worker.completed_commit is not None
        relationship = subprocess.run(
            [
                "git",
                "-C",
                str(repo),
                "merge-base",
                "--is-ancestor",
                worker.base_commit,
                worker.completed_commit,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if relationship.returncode != 0:
            raise ManifestError(
                f"candidate {worker.worker_id} base commit is not an ancestor of its completed commit"
            )
