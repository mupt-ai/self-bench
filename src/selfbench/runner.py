"""Validate tasks and run agent rollouts against them."""

from __future__ import annotations

import json
import shlex
import subprocess
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .result_schema import HARNESS_VERSION, RESULT_SCHEMA_VERSION
from .sandbox import OUT_DIR, REPO_DIR, ExecResult, TaskSandbox, runtime_manifest
from .task import Task

PROMPT_PATH = "/work/prompt.md"
TEST_PATCH_PATH = "/work/test.patch"
GOLD_PATCH_PATH = "/work/gold.patch"
AGENT_PATCH_PATH = "/work/agent.patch"
CAPTURED_AGENT_PATCH_PATH = f"{OUT_DIR}/agent.patch"


@dataclass
class TestOutcome:
    passed: bool
    exit_code: int
    tail: str  # last chunk of test output, for the report


def _run_identity(kind: str) -> tuple[str, datetime]:
    started_at = datetime.now(UTC)
    timestamp = started_at.strftime("%Y%m%dT%H%M%S.%fZ")
    return f"{timestamp}-{kind}-{uuid.uuid4().hex[:12]}", started_at


def _harness_revision() -> str | None:
    repo_root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        ["git", "-C", str(repo_root), "rev-parse", "HEAD"],
        text=True,
        capture_output=True,
        check=False,
    )
    revision = result.stdout.strip()
    if result.returncode != 0 or not revision:
        return None
    status = subprocess.run(
        ["git", "-C", str(repo_root), "status", "--porcelain", "--untracked-files=no"],
        text=True,
        capture_output=True,
        check=False,
    )
    if status.returncode == 0 and status.stdout.strip():
        return f"{revision}-dirty"
    return revision


def _result_metadata(
    task: Task,
    *,
    run_id: str,
    run_kind: str,
    started_at: datetime,
) -> dict[str, object]:
    return {
        "result_schema_version": RESULT_SCHEMA_VERSION,
        "run_id": run_id,
        "run_kind": run_kind,
        "started_at": started_at.isoformat(),
        "finished_at": datetime.now(UTC).isoformat(),
        "harness_version": HARNESS_VERSION,
        "harness_revision": _harness_revision(),
        "runtime": runtime_manifest(),
        "task_fingerprints": task.evaluation_fingerprints,
    }


def _prepare_snapshot(sb: TaskSandbox, task: Task, local_repo: Path) -> None:
    sb.upload_snapshot(local_repo, task.base_commit)


def _run_setup(sb: TaskSandbox, task: Task) -> None:
    sb.exec_checked(
        task.setup_cmd,
        action="setup_cmd",
        workdir=f"{REPO_DIR}/{task.workdir}",
        timeout=task.timeout_setup,
    )


def _run_tests(sb: TaskSandbox, task: Task, tests: list[str]) -> TestOutcome:
    cmd = task.test_cmd.format(tests=" ".join(shlex.quote(t) for t in tests))
    res = sb.exec(cmd, workdir=f"{REPO_DIR}/{task.workdir}", timeout=task.timeout_tests)
    return TestOutcome(passed=res.exit_code == 0, exit_code=res.exit_code, tail=res.output[-4000:])


def _reset_to_base(sb: TaskSandbox) -> None:
    sb.exec_checked(
        "git reset --hard -q HEAD && git clean -fdq",
        action="repository reset",
    )


def _apply_patch(sb: TaskSandbox, patch_path: str, exclude: list[str] | None = None) -> ExecResult:
    flags = ""
    for path in exclude or []:
        path = path.rstrip("/")
        flags += f" --exclude={shlex.quote(path)} --exclude={shlex.quote(path + '/*')}"
    return sb.exec(f"git apply --binary --whitespace=nowarn{flags} {patch_path}")


def _apply_patch_checked(
    sb: TaskSandbox,
    patch_path: str,
    *,
    label: str,
    exclude: list[str] | None = None,
) -> None:
    result = _apply_patch(sb, patch_path, exclude=exclude)
    if result.exit_code != 0:
        raise RuntimeError(
            f"{label} does not apply (exit {result.exit_code}):\n{result.output[-3000:]}"
        )


def validate_task(task: Task, local_repo: Path, verbose: bool = True) -> dict:
    """Gold-validate in fresh base and gold sandboxes.

    No coding agent runs during validation. Separate sandboxes prevent setup or
    test state from the base check from contaminating the gold check.
    """
    run_id, started_at = _run_identity("validation")
    started = time.time()

    with TaskSandbox(verbose=verbose) as base_sb:
        _prepare_snapshot(base_sb, task, local_repo)
        base_sb.put_file(TEST_PATCH_PATH, task.test_patch.encode())
        _apply_patch_checked(base_sb, TEST_PATCH_PATH, label="test.patch")
        _run_setup(base_sb, task)
        base_f2p = _run_tests(base_sb, task, task.fail_to_pass)
        base_p2p = _run_tests(base_sb, task, task.pass_to_pass) if task.pass_to_pass else None

    with TaskSandbox(verbose=verbose) as gold_sb:
        _prepare_snapshot(gold_sb, task, local_repo)
        gold_sb.put_file(GOLD_PATCH_PATH, task.gold_patch.encode())
        gold_sb.put_file(TEST_PATCH_PATH, task.test_patch.encode())
        _apply_patch_checked(gold_sb, GOLD_PATCH_PATH, label="gold.patch")
        _apply_patch_checked(gold_sb, TEST_PATCH_PATH, label="test.patch")
        _run_setup(gold_sb, task)
        gold_f2p_1 = _run_tests(gold_sb, task, task.fail_to_pass)
        gold_f2p_2 = _run_tests(gold_sb, task, task.fail_to_pass)
        gold_p2p = _run_tests(gold_sb, task, task.pass_to_pass) if task.pass_to_pass else None

    checks = {
        "base_f2p_fails": not base_f2p.passed,
        "base_p2p_passes": base_p2p.passed if base_p2p else True,
        "gold_f2p_passes": gold_f2p_1.passed,
        "gold_f2p_deterministic": gold_f2p_1.passed and gold_f2p_2.passed,
        "gold_p2p_passes": gold_p2p.passed if gold_p2p else True,
    }
    result = {
        "task_id": task.task_id,
        "valid": all(checks.values()),
        "checks": checks,
        "base_f2p_tail": base_f2p.tail,
        "base_p2p_tail": base_p2p.tail if base_p2p else "",
        "gold_f2p_tail": gold_f2p_1.tail,
        "gold_p2p_tail": gold_p2p.tail if gold_p2p else "",
        "duration_s": round(time.time() - started, 1),
    }
    result.update(
        _result_metadata(
            task,
            run_id=run_id,
            run_kind="validation",
            started_at=started_at,
        )
    )
    return result


def _run_agent(
    task: Task,
    local_repo: Path,
    *,
    provider: str,
    model: str,
    thinking: str | None,
    verbose: bool,
) -> tuple[ExecResult, str]:
    """Run the coding agent without uploading held-out or gold patches."""
    with TaskSandbox(verbose=verbose) as agent_sb:
        _prepare_snapshot(agent_sb, task, local_repo)
        agent_sb.put_file(PROMPT_PATH, task.prompt.encode())
        _run_setup(agent_sb, task)
        # Setup may populate ignored dependency caches. Restore the tracked tree
        # so the captured patch contains only agent-authored repository changes.
        _reset_to_base(agent_sb)

        pi_cmd = (
            f"pi -p --no-session --provider {shlex.quote(provider)} --model {shlex.quote(model)}"
            + (f" --thinking {shlex.quote(thinking)}" if thinking else "")
            + f' "$(cat {PROMPT_PATH})" </dev/null'
        )
        agent = agent_sb.exec(
            pi_cmd,
            workdir=REPO_DIR,
            timeout=task.timeout_agent,
            provider_secrets=True,
        )
        agent_sb.exec_checked(
            f"git add -A && git diff --cached --binary HEAD > {CAPTURED_AGENT_PATCH_PATH} "
            "&& git reset -q HEAD",
            action="agent patch capture",
        )
        agent_patch = agent_sb.get_file(CAPTURED_AGENT_PATCH_PATH).decode(errors="replace")
    return agent, agent_patch


def _grade_agent_patch(
    task: Task,
    local_repo: Path,
    agent_patch: str,
    *,
    verbose: bool,
) -> tuple[bool, TestOutcome, TestOutcome | None]:
    """Grade in a fresh sandbox that has never executed the coding agent."""
    with TaskSandbox(verbose=verbose) as grader_sb:
        _prepare_snapshot(grader_sb, task, local_repo)
        grader_sb.put_file(TEST_PATCH_PATH, task.test_patch.encode())

        patch_applied = True
        if agent_patch.strip():
            grader_sb.put_file(AGENT_PATCH_PATH, agent_patch.encode())
            applied = _apply_patch(grader_sb, AGENT_PATCH_PATH, exclude=task.test_paths)
            patch_applied = applied.exit_code == 0

        _apply_patch_checked(grader_sb, TEST_PATCH_PATH, label="test.patch")
        _run_setup(grader_sb, task)
        f2p = _run_tests(grader_sb, task, task.fail_to_pass)
        p2p = _run_tests(grader_sb, task, task.pass_to_pass) if task.pass_to_pass else None
    return patch_applied, f2p, p2p


def run_task(
    task: Task,
    local_repo: Path,
    provider: str,
    model: str,
    thinking: str | None = None,
    verbose: bool = True,
) -> dict:
    """Run an agent and grade its patch in a separate fresh sandbox."""
    run_id, started_at = _run_identity("rollout")
    started = time.time()
    agent, agent_patch = _run_agent(
        task,
        local_repo,
        provider=provider,
        model=model,
        thinking=thinking,
        verbose=verbose,
    )
    patch_applied, f2p, p2p = _grade_agent_patch(
        task,
        local_repo,
        agent_patch,
        verbose=verbose,
    )

    p2p_passed = p2p.passed if p2p else True
    agent_exit_ok = agent.exit_code == 0
    resolved = agent_exit_ok and patch_applied and f2p.passed and p2p_passed
    failure_reasons = []
    if not agent_exit_ok:
        failure_reasons.append(f"agent exited {agent.exit_code}")
    if not patch_applied:
        failure_reasons.append("agent patch did not apply")
    if not f2p.passed:
        failure_reasons.append("fail_to_pass tests failed")
    if not p2p_passed:
        failure_reasons.append("pass_to_pass tests failed")
    result = {
        "task_id": task.task_id,
        "provider": provider,
        "model": model,
        "thinking": thinking,
        "prompt_sha256": task.prompt_sha256,
        "resolved": resolved,
        "failure_reasons": failure_reasons,
        "fail_to_pass_passed": f2p.passed,
        "pass_to_pass_passed": p2p_passed,
        "agent_exit_code": agent.exit_code,
        "agent_exit_ok": agent_exit_ok,
        "agent_patch_applied": patch_applied,
        "agent_patch": agent_patch,
        "agent_log_tail": agent.output[-6000:],
        "f2p_tail": f2p.tail,
        "p2p_tail": p2p.tail if p2p else "",
        "duration_s": round(time.time() - started, 1),
    }
    result.update(
        _result_metadata(
            task,
            run_id=run_id,
            run_kind="rollout",
            started_at=started_at,
        )
    )
    return result


def save_result(result: dict, results_root: Path, subdir: str) -> Path:
    """Save an immutable run and refresh the backward-compatible latest result."""
    task_id = result.get("task_id")
    for label, value in (("task_id", task_id), ("result subdir", subdir)):
        if not isinstance(value, str) or not value or Path(value).name != value:
            raise ValueError(f"{label} must be a non-empty path-safe string")
    out = results_root / task_id / subdir
    out.mkdir(parents=True, exist_ok=True)

    run_id = result.get("run_id")
    if not isinstance(run_id, str) or not run_id or Path(run_id).name != run_id:
        raise ValueError("result run_id must be a non-empty path-safe string")
    run_dir = out / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=False)

    serialized = json.dumps(result, indent=2)
    if "agent_patch" in result:
        agent_patch = str(result["agent_patch"])
        (run_dir / "agent.patch").write_text(agent_patch)
        (out / "agent.patch").write_text(agent_patch)
    (run_dir / "result.json").write_text(serialized)
    latest_path = out / "result.json"
    latest_path.write_text(serialized)
    return latest_path
