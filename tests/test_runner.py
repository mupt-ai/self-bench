from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from selfbench.cli import _model_slug
from selfbench.runner import (
    AGENT_PATCH_PATH,
    CAPTURED_AGENT_PATCH_PATH,
    GOLD_PATCH_PATH,
    PROMPT_PATH,
    TEST_PATCH_PATH,
    run_task,
    save_result,
    validate_task,
)
from selfbench.sandbox import ExecResult
from selfbench.task import Task


AGENT_PATCH = """\
diff --git a/src/fix.py b/src/fix.py
new file mode 100644
--- /dev/null
+++ b/src/fix.py
@@ -0,0 +1 @@
+fixed = True
"""


class FakeSandbox:
    instances: list["FakeSandbox"] = []
    fail_test_patch = False
    fail_setup = False

    def __init__(self, verbose: bool = True):
        self.index = len(self.instances)
        self.verbose = verbose
        self.files: dict[str, bytes] = {}
        self.exec_calls: list[dict[str, object]] = []
        self.instances.append(self)

    def __enter__(self) -> "FakeSandbox":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def upload_snapshot(self, local_repo: Path, base_commit: str) -> None:
        self.local_repo = local_repo
        self.base_commit = base_commit

    def put_file(self, remote_path: str, data: bytes) -> None:
        self.files[remote_path] = data

    def get_file(self, remote_path: str) -> bytes:
        return self.files[remote_path]

    def exec(
        self,
        cmd: str,
        workdir: str = "/work/repo",
        timeout: int = 600,
        *,
        provider_secrets: bool = False,
    ) -> ExecResult:
        self.exec_calls.append(
            {
                "cmd": cmd,
                "workdir": workdir,
                "timeout": timeout,
                "provider_secrets": provider_secrets,
            }
        )
        if self.fail_test_patch and cmd.endswith(TEST_PATCH_PATH):
            return ExecResult(exit_code=1, output="bad test patch")
        if self.fail_setup and cmd == "setup":
            return ExecResult(exit_code=1, output="bad setup")
        if cmd.startswith("pi "):
            return ExecResult(exit_code=0, output="agent completed")
        if cmd == "run f2p" and self.index == 0:
            return ExecResult(exit_code=1, output="expected base failure")
        return ExecResult(exit_code=0, output="ok")

    def exec_checked(
        self,
        cmd: str,
        *,
        action: str,
        workdir: str = "/work/repo",
        timeout: int = 600,
        provider_secrets: bool = False,
    ) -> ExecResult:
        result = self.exec(
            cmd,
            workdir=workdir,
            timeout=timeout,
            provider_secrets=provider_secrets,
        )
        if "git diff --cached" in cmd:
            self.files[CAPTURED_AGENT_PATCH_PATH] = AGENT_PATCH.encode()
        if result.exit_code != 0:
            raise RuntimeError(f"{action} failed")
        return result


class RunnerIsolationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.task_dir = self.root / "task"
        self.task_dir.mkdir()
        (self.task_dir / "prompt.md").write_text("Fix the observable behavior with a focused change.")
        (self.task_dir / "test.patch").write_text("test patch")
        (self.task_dir / "gold.patch").write_text("gold patch")
        self.task = Task(
            task_id="example-task",
            repo="example/repo",
            base_commit="abc123",
            workdir=".",
            setup_cmd="setup",
            test_cmd="run {tests}",
            fail_to_pass=["f2p"],
            pass_to_pass=["p2p"],
            test_paths=["tests"],
            dir=self.task_dir,
        )
        FakeSandbox.instances = []
        FakeSandbox.fail_test_patch = False
        FakeSandbox.fail_setup = False

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @patch("selfbench.runner._harness_revision", return_value="test-revision")
    @patch("selfbench.runner.TaskSandbox", FakeSandbox)
    def test_rollout_keeps_hidden_patches_out_of_agent_sandbox(self, _revision: object) -> None:
        result = run_task(
            self.task,
            self.root,
            provider="provider",
            model="model",
            thinking="high",
            verbose=False,
        )

        self.assertEqual(len(FakeSandbox.instances), 2)
        agent, grader = FakeSandbox.instances
        self.assertIn(PROMPT_PATH, agent.files)
        self.assertNotIn(TEST_PATCH_PATH, agent.files)
        self.assertNotIn(GOLD_PATCH_PATH, agent.files)
        self.assertIn(TEST_PATCH_PATH, grader.files)
        self.assertIn(AGENT_PATCH_PATH, grader.files)
        self.assertNotIn(PROMPT_PATH, grader.files)
        self.assertNotIn(GOLD_PATCH_PATH, grader.files)

        secret_calls = [call for call in agent.exec_calls if call["provider_secrets"]]
        self.assertEqual(len(secret_calls), 1)
        self.assertTrue(str(secret_calls[0]["cmd"]).startswith("pi "))
        self.assertFalse(any(call["provider_secrets"] for call in grader.exec_calls))

        self.assertTrue(result["resolved"])
        self.assertEqual(result["thinking"], "high")
        self.assertEqual(result["harness_revision"], "test-revision")
        self.assertEqual(result["task_fingerprints"], self.task.evaluation_fingerprints)

    @patch("selfbench.runner._harness_revision", return_value="test-revision")
    @patch("selfbench.runner.TaskSandbox", FakeSandbox)
    def test_validation_uses_fresh_base_and_gold_sandboxes(self, _revision: object) -> None:
        result = validate_task(self.task, self.root, verbose=False)

        self.assertEqual(len(FakeSandbox.instances), 2)
        base, gold = FakeSandbox.instances
        self.assertIn(TEST_PATCH_PATH, base.files)
        self.assertNotIn(GOLD_PATCH_PATH, base.files)
        self.assertIn(TEST_PATCH_PATH, gold.files)
        self.assertIn(GOLD_PATCH_PATH, gold.files)
        self.assertTrue(result["valid"])
        self.assertTrue(result["checks"]["gold_f2p_deterministic"])

    @patch("selfbench.runner.TaskSandbox", FakeSandbox)
    def test_validation_fails_closed_when_test_patch_does_not_apply(self) -> None:
        FakeSandbox.fail_test_patch = True

        with self.assertRaisesRegex(RuntimeError, "test.patch does not apply"):
            validate_task(self.task, self.root, verbose=False)

    @patch("selfbench.runner.TaskSandbox", FakeSandbox)
    def test_validation_fails_closed_when_setup_fails(self) -> None:
        FakeSandbox.fail_setup = True

        with self.assertRaisesRegex(RuntimeError, "setup_cmd failed"):
            validate_task(self.task, self.root, verbose=False)


class ResultHistoryTest(unittest.TestCase):
    def test_save_result_preserves_each_run_and_refreshes_latest(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            results = Path(raw_dir)
            first = {
                "run_id": "run-one",
                "task_id": "task",
                "resolved": False,
                "agent_patch": "first",
            }
            second = {
                "run_id": "run-two",
                "task_id": "task",
                "resolved": True,
                "agent_patch": "second",
            }

            latest = save_result(first, results, "provider__model")
            save_result(second, results, "provider__model")

            self.assertFalse(
                json.loads(
                    (results / "task/provider__model/runs/run-one/result.json").read_text()
                )["resolved"]
            )
            self.assertTrue(
                json.loads(
                    (results / "task/provider__model/runs/run-two/result.json").read_text()
                )["resolved"]
            )
            self.assertTrue(json.loads(latest.read_text())["resolved"])
            self.assertEqual((latest.parent / "agent.patch").read_text(), "second")

    def test_save_result_rejects_unsafe_or_duplicate_run_ids(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            results = Path(raw_dir)
            with self.assertRaisesRegex(ValueError, "path-safe"):
                save_result(
                    {"run_id": "../escape", "task_id": "task"},
                    results,
                    "provider__model",
                )
            with self.assertRaisesRegex(ValueError, "result subdir"):
                save_result(
                    {"run_id": "run", "task_id": "task"},
                    results,
                    "../escape",
                )

            result = {"run_id": "same-run", "task_id": "task"}
            save_result(result, results, "provider__model")
            with self.assertRaises(FileExistsError):
                save_result(result, results, "provider__model")


class CliPathTest(unittest.TestCase):
    def test_model_slug_keeps_model_tail_and_rejects_path_unsafe_provider(self) -> None:
        self.assertEqual(_model_slug("openai", "org/model"), "openai__model")
        with self.assertRaisesRegex(ValueError, "provider"):
            _model_slug("../provider", "model")


if __name__ == "__main__":
    unittest.main()
