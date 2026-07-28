"""Launch Pi with selfbench's task-building skill."""

from __future__ import annotations

import subprocess
from importlib.resources import as_file, files
from pathlib import Path
from typing import Iterable


def build_create_request(
    request: Iterable[str],
    *,
    repo: Path | None = None,
    tasks_root: Path = Path("tasks"),
) -> str:
    """Build the initial instruction passed to the task-building agent."""
    tasks_root = tasks_root.expanduser().resolve()
    lines = [
        "Use the loaded selfbench skill to discover and create benchmark tasks.",
        f"Write authoring artifacts under: {tasks_root}",
    ]
    if repo is not None:
        repo = repo.expanduser().resolve()
        if not repo.is_dir():
            raise ValueError(f"source repository does not exist or is not a directory: {repo}")
        lines.append(f"Source repository: {repo}")
    user_request = " ".join(request).strip()
    if user_request:
        lines.extend(("", user_request))
    else:
        lines.extend(
            (
                "",
                "No pull request is preselected. Inspect the repository's merged pull requests, compare them "
                "against existing tasks and rejected candidates under the task root, rank unseen candidates "
                "using the skill's acceptance criteria, and build the strongest viable task or tasks. Do not "
                "ask me to nominate PR numbers; only ask if access, provenance, or another hard blocker prevents "
                "you from choosing safely.",
            )
        )
    return "\n".join(lines)


def launch_create_agent(
    request: Iterable[str],
    *,
    repo: Path | None = None,
    tasks_root: Path = Path("tasks"),
    provider: str | None = None,
    model: str | None = None,
    thinking: str | None = None,
    print_mode: bool = False,
    pi_executable: str = "pi",
    skill_path: Path | None = None,
) -> int:
    """Run Pi with the bundled skill and return its exit code."""
    prompt = build_create_request(request, repo=repo, tasks_root=tasks_root)

    def run(resolved_skill: Path) -> int:
        command = [pi_executable, "--skill", str(resolved_skill)]
        if provider:
            command.extend(("--provider", provider))
        if model:
            command.extend(("--model", model))
        if thinking:
            command.extend(("--thinking", thinking))
        if print_mode:
            command.append("--print")
        command.append(prompt)
        try:
            return subprocess.run(command, check=False).returncode
        except FileNotFoundError as exc:
            raise RuntimeError(
                f"Pi executable not found: {pi_executable}. Install Pi or pass --pi-executable."
            ) from exc

    if skill_path is not None:
        return run(skill_path.resolve())

    skill = files("selfbench").joinpath("skills/selfbench/SKILL.md")
    with as_file(skill) as resolved_skill:
        return run(resolved_skill)
