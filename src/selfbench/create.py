"""Launch Pi with selfbench's task-building skill."""

from __future__ import annotations

import subprocess
from importlib.resources import as_file, files
from pathlib import Path
from typing import Iterable

PROFILES = ("default", "hard")

# Standing per-repository goal for the hard profile when the user does not pass --count.
HARD_PROFILE_DEFAULT_COUNT = 15


def build_create_request(
    request: Iterable[str],
    *,
    repo: Path | None = None,
    tasks_root: Path = Path("tasks"),
    count: int | None = None,
    profile: str = "default",
) -> str:
    """Build the initial instruction passed to the task-building agent."""
    if profile not in PROFILES:
        raise ValueError(f"unknown difficulty profile: {profile!r} (choose from {', '.join(PROFILES)})")
    tasks_root = tasks_root.expanduser().resolve()
    lines = [
        "Use the loaded selfbench skill to discover and create benchmark tasks.",
        f"Write authoring artifacts under: {tasks_root}",
        (
            "After authoring the full batch, deterministic nop/oracle validation and static audit are allowed. "
            "Do not run benchmark solver trials: never invoke selfbench run or start Harbor with a coding "
            "agent/model unless the user explicitly asks."
        ),
    ]
    if count is not None:
        if count < 1:
            raise ValueError("task count must be a positive integer")
        lines.append(
            f"Target batch size: {count}. Create exactly {count} complete benchmark "
            "task directories unless a genuine hard blocker exhausts the viable candidates."
        )
    if profile == "hard":
        validated_target = count if count is not None else HARD_PROFILE_DEFAULT_COUNT
        lines.append(
            "Difficulty profile: hard. Apply the skill's hard difficulty profile during candidate discovery: "
            "use changed-file and changed-line metadata only to shortlist larger merged pull requests, then "
            "read the actual diffs and rank candidates by behavioral scope and implementation complexity, "
            "keeping every provenance, patch-separability, equivalent-design, and deterministic-validation "
            "gate unchanged."
        )
        lines.append(
            f"Hard-profile goal: {validated_target} tasks from this repository that pass deterministic "
            "nop/oracle validation, counted as validated tasks rather than shortlisted PRs or authored "
            "directories. After the batch-first authoring and validation pass, replace rejected or "
            "validation-failing tasks with the next ranked provenance-backed candidates, author and "
            f"revalidate the replacements, and continue until {validated_target} tasks pass validation. "
            "Stop short only when the viable provenance-backed pool is exhausted, and then report the "
            "exact blocker and the shortfall."
        )
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
    count: int | None = None,
    profile: str = "default",
    provider: str | None = None,
    model: str | None = None,
    thinking: str | None = None,
    print_mode: bool = False,
    pi_executable: str = "pi",
    skill_path: Path | None = None,
) -> int:
    """Run Pi with the bundled skill and return its exit code."""
    prompt = build_create_request(request, repo=repo, tasks_root=tasks_root, count=count, profile=profile)

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
