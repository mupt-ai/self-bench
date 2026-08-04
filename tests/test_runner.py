from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from selfbench.cli import _harbor_run_command, _iter_task_dirs
from selfbench.harbor import HarborRun, build_harbor_task
from selfbench.harbor_pi import PI_VERSION, _provider_error
from selfbench.runner import save_result, validate_task
from selfbench.task import Task

AGENT_PATCH = """\
diff --git a/src/fix.py b/src/fix.py
new file mode 100644
--- /dev/null
+++ b/src/fix.py
@@ -0,0 +1 @@
+fixed = True
"""


class HarborTaskBuildTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(["git", "-C", str(self.repo), "config", "user.email", "test@example.com"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "config", "user.name", "Test"], check=True)
        (self.repo / "src").mkdir()
        (self.repo / "src" / "base.py").write_text("base = True\n")
        subprocess.run(["git", "-C", str(self.repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-qm", "base"], check=True)
        self.commit = subprocess.run(
            ["git", "-C", str(self.repo), "rev-parse", "HEAD"],
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()

        self.authoring_dir = self.root / "authoring"
        self.authoring_dir.mkdir()
        (self.authoring_dir / "prompt.md").write_text("Fix the public behavior without changing its documented interface.\n")
        (self.authoring_dir / "test.patch").write_text("diff --git a/tests/x.py b/tests/x.py\n")
        (self.authoring_dir / "gold.patch").write_text(AGENT_PATCH)
        self.task = Task(
            task_id="example-task",
            repo="example/repo",
            base_commit=self.commit,
            workdir=".",
            setup_cmd="true",
            test_cmd="pytest {tests}",
            fail_to_pass=["tests/x.py::test_fix"],
            pass_to_pass=["tests/y.py"],
            test_paths=["tests"],
            trace_source={"path": "inputs/source.jsonl", "format": "pi"},
            dir=self.authoring_dir,
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_builds_a_sealed_native_harbor_task(self) -> None:
        output = build_harbor_task(self.task, self.repo, self.root / "harbor-tasks")

        self.assertTrue((output / "task.toml").is_file())
        self.assertTrue((output / "instruction.md").is_file())
        self.assertTrue((output / "environment" / "Dockerfile").is_file())
        self.assertTrue((output / "solution" / "solve.sh").is_file())
        self.assertTrue((output / "tests" / "test.sh").is_file())
        self.assertNotIn("source.jsonl", {path.name for path in output.rglob("*")})
        self.assertFalse((output / "task.json").exists())

        config = (output / "task.toml").read_text()
        self.assertIn('schema_version = "1.4"', config)
        self.assertIn('environment_mode = "separate"', config)
        self.assertIn('name = "selfbench/example-task"', config)
        self.assertIn('/opt/selfbench/agent.patch', config)

        verifier = (output / "tests" / "test.sh").read_text()
        self.assertIn("/tests/test.patch", verifier)
        self.assertIn("--exclude=tests", verifier)
        self.assertIn('"reward": $reward', verifier)

    def test_reuses_current_build_and_rejects_stale_output(self) -> None:
        output = build_harbor_task(self.task, self.repo, self.root / "harbor-tasks")
        self.assertEqual(
            build_harbor_task(self.task, self.repo, self.root / "harbor-tasks"),
            output,
        )
        (output / ".selfbench-manifest.json").write_text("{}")
        with self.assertRaisesRegex(FileExistsError, "pass --force"):
            build_harbor_task(self.task, self.repo, self.root / "harbor-tasks")


class HarborRunnerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        task_dir = self.root / "task"
        task_dir.mkdir()
        (task_dir / "prompt.md").write_text("Fix the observable behavior with a focused change.")
        (task_dir / "test.patch").write_text("test patch")
        (task_dir / "gold.patch").write_text("gold patch")
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
            dir=task_dir,
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @patch("selfbench.runner.build_harbor_task", return_value=Path("/tmp/task"))
    @patch("selfbench.runner.run_harbor_task")
    def test_validation_runs_nop_and_oracle_through_harbor(self, run, _build) -> None:
        base = _fake_run(self.root / "base", {"fail_to_pass": 0, "pass_to_pass": 1})
        oracle = _fake_run(
            self.root / "oracle",
            {"reward": 1, "patch_applied": 1, "fail_to_pass": 1, "pass_to_pass": 1, "deterministic": 1},
        )
        run.side_effect = [base, oracle]

        result = validate_task(self.task, self.root, verbose=False)

        self.assertEqual([call.kwargs["agent"] for call in run.call_args_list], ["nop", "oracle"])
        self.assertTrue(result["valid"])
        self.assertTrue(result["checks"]["base_f2p_fails"])
        self.assertEqual(result["harbor"]["task_dir"], str(Path("/tmp/task").resolve()))


class HarborPiTest(unittest.TestCase):
    def test_current_pi_version_is_pinned(self) -> None:
        self.assertEqual(PI_VERSION, "0.82.1")

    def test_provider_error_is_not_treated_as_agent_success(self) -> None:
        output = "\n".join(
            [
                json.dumps({"type": "message_end", "message": {"role": "user"}}),
                json.dumps(
                    {
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "stopReason": "error",
                            "errorMessage": "400 incompatible thinking config",
                        },
                    }
                ),
            ]
        )
        self.assertEqual(_provider_error(output), "400 incompatible thinking config")
        self.assertIsNone(
            _provider_error(
                json.dumps(
                    {
                        "type": "message_end",
                        "message": {"role": "assistant", "stopReason": "stop"},
                    }
                )
            )
        )


class ResultHistoryTest(unittest.TestCase):
    def test_save_result_preserves_each_run_and_refreshes_latest(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            results = Path(raw_dir)
            first = {"run_id": "run-one", "task_id": "task", "resolved": False, "agent_patch": "first"}
            second = {"run_id": "run-two", "task_id": "task", "resolved": True, "agent_patch": "second"}

            latest = save_result(first, results, "provider__model")
            save_result(second, results, "provider__model")

            self.assertFalse(json.loads((results / "task/provider__model/runs/run-one/result.json").read_text())["resolved"])
            self.assertTrue(json.loads((results / "task/provider__model/runs/run-two/result.json").read_text())["resolved"])
            self.assertTrue(json.loads(latest.read_text())["resolved"])
            self.assertEqual((latest.parent / "agent.patch").read_text(), "second")

    def test_save_result_rejects_unsafe_or_duplicate_run_ids(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            results = Path(raw_dir)
            with self.assertRaisesRegex(ValueError, "path-safe"):
                save_result({"run_id": "../escape", "task_id": "task"}, results, "provider__model")
            result = {"run_id": "same-run", "task_id": "task"}
            save_result(result, results, "provider__model")
            with self.assertRaises(FileExistsError):
                save_result(result, results, "provider__model")


class HarborCommandTest(unittest.TestCase):
    def test_uses_harbor_directly_with_the_current_pi_adapter(self) -> None:
        command = _harbor_run_command(Path("harbor-tasks/example task"))

        self.assertIn("harbor run", command)
        self.assertIn("selfbench.harbor_pi:SelfbenchPi", command)
        self.assertIn("openai/gpt-4.1", command)
        self.assertIn("'harbor-tasks/example task'", command)
        self.assertNotIn("selfbench run", command)

    def test_discovers_one_task_or_every_direct_child(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            first = root / "first"
            second = root / "second"
            ignored = root / "notes"
            for path in (first, second, ignored):
                path.mkdir()
            (first / "task.json").write_text("{}")
            (second / "task.json").write_text("{}")

            self.assertEqual(_iter_task_dirs([str(first)]), [first])
            self.assertEqual(_iter_task_dirs([str(root)]), [first, second])


def _fake_run(root: Path, rewards: dict[str, float | int]) -> HarborRun:
    trial = root / "trial"
    (trial / "artifacts" / "opt" / "selfbench").mkdir(parents=True)
    (trial / "artifacts" / "opt" / "selfbench" / "agent.patch").write_text(AGENT_PATCH)
    result = {
        "id": root.name,
        "trial_name": root.name,
        "started_at": "2026-01-01T00:00:00+00:00",
        "finished_at": "2026-01-01T00:00:01+00:00",
        "agent_info": {
            "name": "pi",
            "version": "1.0",
            "model_info": {"provider": "openai", "name": "gpt-test"},
        },
        "verifier_result": {"rewards": rewards},
    }
    return HarborRun(root, trial, {"trial_results": [result]}, result)


if __name__ == "__main__":
    unittest.main()
