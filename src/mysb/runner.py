"""Validate tasks and run agent rollouts against them."""

from __future__ import annotations

import json
import shlex
import time
from dataclasses import dataclass
from pathlib import Path

from .sandbox import OUT_DIR, REPO_DIR, ExecResult, TaskSandbox
from .task import Task

PROMPT_PATH = "/work/prompt.md"
TEST_PATCH_PATH = "/work/test.patch"
GOLD_PATCH_PATH = "/work/gold.patch"


@dataclass
class TestOutcome:
    passed: bool
    exit_code: int
    tail: str  # last chunk of test output, for the report


def _prepare(sb: TaskSandbox, task: Task, local_repo: Path) -> None:
    sb.upload_snapshot(local_repo, task.base_commit)
    sb.put_file(PROMPT_PATH, task.prompt.encode())
    sb.put_file(TEST_PATCH_PATH, task.test_patch.encode())
    sb.put_file(GOLD_PATCH_PATH, task.gold_patch.encode())
    res = sb.exec(task.setup_cmd, workdir=f"{REPO_DIR}/{task.workdir}", timeout=task.timeout_setup)
    if res.exit_code != 0:
        raise RuntimeError(f"setup_cmd failed (exit {res.exit_code}):\n{res.output[-3000:]}")


def _run_tests(sb: TaskSandbox, task: Task, tests: list[str]) -> TestOutcome:
    cmd = task.test_cmd.format(tests=" ".join(shlex.quote(t) for t in tests))
    res = sb.exec(cmd, workdir=f"{REPO_DIR}/{task.workdir}", timeout=task.timeout_tests)
    return TestOutcome(passed=res.exit_code == 0, exit_code=res.exit_code, tail=res.output[-4000:])


def _reset_to_base(sb: TaskSandbox) -> None:
    sb.exec("git reset --hard -q HEAD && git clean -fdq")


def _apply_patch(sb: TaskSandbox, patch_path: str, exclude: list[str] | None = None) -> ExecResult:
    flags = ""
    for p in exclude or []:
        p = p.rstrip("/")
        flags += f" --exclude={shlex.quote(p)} --exclude={shlex.quote(p + '/*')}"
    return sb.exec(f"git apply --binary --whitespace=nowarn{flags} {patch_path}")


def validate_task(task: Task, local_repo: Path, verbose: bool = True) -> dict:
    """Gold validation: base must fail FAIL_TO_PASS, gold must pass everything.
    Gold tests run twice to catch flakes. Returns a result dict; 'valid' is the verdict."""
    started = time.time()
    with TaskSandbox(verbose=verbose) as sb:
        _prepare(sb, task, local_repo)

        _apply_patch(sb, TEST_PATCH_PATH)
        base_f2p = _run_tests(sb, task, task.fail_to_pass)
        base_p2p = _run_tests(sb, task, task.pass_to_pass) if task.pass_to_pass else None

        _reset_to_base(sb)
        gold = _apply_patch(sb, GOLD_PATCH_PATH)
        if gold.exit_code != 0:
            raise RuntimeError(f"gold.patch does not apply:\n{gold.output[-2000:]}")
        _apply_patch(sb, TEST_PATCH_PATH)
        sb.exec(task.setup_cmd, workdir=f"{REPO_DIR}/{task.workdir}", timeout=task.timeout_setup)
        gold_f2p_1 = _run_tests(sb, task, task.fail_to_pass)
        gold_f2p_2 = _run_tests(sb, task, task.fail_to_pass)
        gold_p2p = _run_tests(sb, task, task.pass_to_pass) if task.pass_to_pass else None

    checks = {
        "base_f2p_fails": not base_f2p.passed,
        "base_p2p_passes": base_p2p.passed if base_p2p else True,
        "gold_f2p_passes": gold_f2p_1.passed,
        "gold_f2p_deterministic": gold_f2p_1.passed == gold_f2p_2.passed,
        "gold_p2p_passes": gold_p2p.passed if gold_p2p else True,
    }
    return {
        "task_id": task.task_id,
        "valid": all(checks.values()),
        "checks": checks,
        "base_f2p_tail": base_f2p.tail,
        "base_p2p_tail": base_p2p.tail if base_p2p else "",
        "gold_f2p_tail": gold_f2p_1.tail,
        "gold_p2p_tail": gold_p2p.tail if gold_p2p else "",
        "duration_s": round(time.time() - started, 1),
    }


def run_task(
    task: Task,
    local_repo: Path,
    provider: str,
    model: str,
    thinking: str | None = None,
    verbose: bool = True,
) -> dict:
    """One rollout: agent solves the task from the prompt alone, then the PR's
    own tests judge the result. Returns a result dict; 'resolved' is the verdict."""
    started = time.time()
    with TaskSandbox(verbose=verbose) as sb:
        _prepare(sb, task, local_repo)

        pi_cmd = (
            f"pi -p --no-session --provider {shlex.quote(provider)} --model {shlex.quote(model)}"
            + (f" --thinking {shlex.quote(thinking)}" if thinking else "")
            + f' "$(cat {PROMPT_PATH})" </dev/null'  # pi hangs waiting on stdin without this
        )
        agent = sb.exec(pi_cmd, workdir=REPO_DIR, timeout=task.timeout_agent)

        sb.exec(f"git add -A && git diff --cached --binary HEAD > {OUT_DIR}/agent.patch && git reset -q HEAD")
        agent_patch = sb.get_file(f"{OUT_DIR}/agent.patch").decode(errors="replace")

        _reset_to_base(sb)
        patch_applied = True
        if agent_patch.strip():
            applied = _apply_patch(sb, f"{OUT_DIR}/agent.patch", exclude=task.test_paths)
            patch_applied = applied.exit_code == 0
        _apply_patch(sb, TEST_PATCH_PATH)
        sb.exec(task.setup_cmd, workdir=f"{REPO_DIR}/{task.workdir}", timeout=task.timeout_setup)

        f2p = _run_tests(sb, task, task.fail_to_pass)
        p2p = _run_tests(sb, task, task.pass_to_pass) if task.pass_to_pass else None

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
    return {
        "task_id": task.task_id,
        "provider": provider,
        "model": model,
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


def save_result(result: dict, results_root: Path, subdir: str) -> Path:
    out = results_root / result["task_id"] / subdir
    out.mkdir(parents=True, exist_ok=True)
    if "agent_patch" in result:
        (out / "agent.patch").write_text(result["agent_patch"])
    (out / "result.json").write_text(json.dumps(result, indent=2))
    return out / "result.json"
