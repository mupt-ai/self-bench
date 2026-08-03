from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from selfbench.cli import _model_slug
from selfbench.harbor import HarborRun, build_harbor_task
from selfbench.harbor_pi import PI_VERSION, _provider_error
from selfbench.runner import (
    DEFAULT_ROLLOUT_ENVIRONMENT,
    DEFAULT_VALIDATION_ENVIRONMENT,
    BatchValidationOutcome,
    is_currently_valid,
    run_task,
    save_result,
    validate_batch,
    validate_task,
)
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

    @patch("selfbench.runner.build_harbor_task", return_value=Path("/tmp/task"))
    @patch("selfbench.runner.run_harbor_task")
    def test_rollout_delegates_agent_model_and_thinking_to_harbor(self, run, _build) -> None:
        run.return_value = _fake_run(
            self.root / "rollout",
            {"reward": 1, "patch_applied": 1, "fail_to_pass": 1, "pass_to_pass": 1, "deterministic": 1},
        )

        result = run_task(
            self.task,
            self.root,
            provider="openai",
            model="gpt-test",
            thinking="high",
            agent="pi",
            verbose=False,
        )

        self.assertEqual(run.call_args.kwargs["agent"], "pi")
        self.assertEqual(run.call_args.kwargs["model"], "openai/gpt-test")
        self.assertEqual(run.call_args.kwargs["agent_kwargs"], {"thinking": "high"})
        self.assertTrue(result["resolved"])
        self.assertEqual(result["result_schema_version"], "harbor-1")

    @patch("selfbench.runner.build_harbor_task", return_value=Path("/tmp/task"))
    @patch("selfbench.runner.run_harbor_task")
    def test_rollout_preserves_nested_model_id_after_provider_prefix(self, run, _build) -> None:
        run.return_value = _fake_run(
            self.root / "rollout",
            {"reward": 1, "patch_applied": 1, "fail_to_pass": 1, "pass_to_pass": 1, "deterministic": 1},
        )

        run_task(
            self.task,
            self.root,
            provider="openrouter",
            model="deepseek/deepseek-v4-flash",
            agent="pi",
            verbose=False,
        )

        self.assertEqual(
            run.call_args.kwargs["model"],
            "openrouter/deepseek/deepseek-v4-flash",
        )


class EnvironmentDefaultTest(unittest.TestCase):
    """Validation defaults to Modal; rollouts keep the Docker default."""

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
    def test_validation_defaults_to_modal(self, run, _build) -> None:
        run.side_effect = [
            _fake_run(self.root / "base", {"reward": 0, "fail_to_pass": 0, "pass_to_pass": 1}),
            _fake_run(
                self.root / "oracle",
                {"reward": 1, "patch_applied": 1, "fail_to_pass": 1, "pass_to_pass": 1, "deterministic": 1},
            ),
        ]

        result = validate_task(self.task, self.root, verbose=False)

        self.assertEqual(DEFAULT_VALIDATION_ENVIRONMENT, "modal")
        self.assertEqual(
            [call.kwargs["environment"] for call in run.call_args_list],
            ["modal", "modal"],
        )
        self.assertTrue(result["valid"])

    @patch("selfbench.runner.build_harbor_task", return_value=Path("/tmp/task"))
    @patch("selfbench.runner.run_harbor_task")
    def test_validation_docker_override_passes_docker(self, run, _build) -> None:
        run.side_effect = [
            _fake_run(self.root / "base", {"reward": 0, "fail_to_pass": 0, "pass_to_pass": 1}),
            _fake_run(
                self.root / "oracle",
                {"reward": 1, "patch_applied": 1, "fail_to_pass": 1, "pass_to_pass": 1, "deterministic": 1},
            ),
        ]

        validate_task(self.task, self.root, environment="docker", verbose=False)

        self.assertEqual(
            [call.kwargs["environment"] for call in run.call_args_list],
            ["docker", "docker"],
        )

    @patch("selfbench.runner.build_harbor_task", return_value=Path("/tmp/task"))
    @patch("selfbench.runner.run_harbor_task")
    def test_rollout_keeps_docker_default(self, run, _build) -> None:
        run.return_value = _fake_run(
            self.root / "rollout",
            {"reward": 1, "patch_applied": 1, "fail_to_pass": 1, "pass_to_pass": 1, "deterministic": 1},
        )

        run_task(self.task, self.root, provider="openai", model="gpt-test", agent="pi", verbose=False)

        self.assertEqual(DEFAULT_ROLLOUT_ENVIRONMENT, "docker")
        self.assertEqual(run.call_args.kwargs["environment"], "docker")


class ValidationSkipTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        task_dir = self.root / "task"
        task_dir.mkdir()
        (task_dir / "prompt.md").write_text("Fix the observable behavior.")
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

    def _write_validation(self, *, valid: bool, schema_ok: bool = True, fingerprints_ok: bool = True) -> None:
        out = self.root / "results" / self.task.task_id / "validation"
        out.mkdir(parents=True, exist_ok=True)
        data = {
            "result_schema_version": "harbor-1" if schema_ok else "legacy",
            "task_fingerprints": self.task.evaluation_fingerprints if fingerprints_ok else {"definition_sha256": "stale"},
            "valid": valid,
        }
        (out / "result.json").write_text(json.dumps(data))

    def test_missing_result_is_not_current(self) -> None:
        self.assertFalse(is_currently_valid(self.task, self.root / "results"))

    def test_current_valid_result_is_skippable(self) -> None:
        self._write_validation(valid=True)
        self.assertTrue(is_currently_valid(self.task, self.root / "results"))

    def test_invalid_result_is_not_skippable(self) -> None:
        self._write_validation(valid=False)
        self.assertFalse(is_currently_valid(self.task, self.root / "results"))

    def test_stale_schema_or_fingerprints_are_not_skippable(self) -> None:
        self._write_validation(valid=True, schema_ok=False)
        self.assertFalse(is_currently_valid(self.task, self.root / "results"))
        self._write_validation(valid=True, fingerprints_ok=False)
        self.assertFalse(is_currently_valid(self.task, self.root / "results"))


class BatchValidationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.tasks: list[Task] = []
        for index in range(3):
            task_dir = self.root / "tasks" / f"task-{index}"
            task_dir.mkdir(parents=True)
            (task_dir / "prompt.md").write_text(f"Fix task {index}.")
            (task_dir / "test.patch").write_text("test patch")
            (task_dir / "gold.patch").write_text("gold patch")
            self.tasks.append(
                Task(
                    task_id=f"task-{index}",
                    repo=f"example/repo{index}",
                    base_commit="abc123",
                    workdir=".",
                    setup_cmd="setup",
                    test_cmd="run {tests}",
                    fail_to_pass=["f2p"],
                    pass_to_pass=["p2p"],
                    test_paths=["tests"],
                    dir=task_dir,
                )
            )
        self.repos = {task.repo: self.root / f"repo{index}" for index, task in enumerate(self.tasks)}

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @patch("selfbench.runner.validate_task")
    def test_batch_runs_all_tasks_on_modal_and_saves_results(self, validate) -> None:
        validate.side_effect = [
            {
                "result_schema_version": "harbor-1",
                "run_id": f"run-{index}",
                "run_kind": "validation",
                "task_id": task.task_id,
                "valid": True,
                "checks": {},
                "task_fingerprints": task.evaluation_fingerprints,
                "duration_s": 1.0,
            }
            for index, task in enumerate(self.tasks)
        ]

        outcomes = validate_batch(
            self.tasks,
            lambda task: self.repos[task.repo],
            results_root=self.root / "results",
            environment="modal",
            concurrency=2,
        )

        self.assertEqual(sorted(o.status for o in outcomes), ["valid", "valid", "valid"])
        self.assertEqual(validate.call_count, 3)
        for call in validate.call_args_list:
            self.assertEqual(call.kwargs["environment"], "modal")
        for task in self.tasks:
            result_path = self.root / "results" / task.task_id / "validation" / "result.json"
            self.assertTrue(result_path.is_file())
            self.assertTrue(json.loads(result_path.read_text())["valid"])

    @patch("selfbench.runner.validate_task")
    def test_docker_override_is_forwarded(self, validate) -> None:
        validate.return_value = {
            "result_schema_version": "harbor-1",
            "run_id": "run",
            "run_kind": "validation",
            "task_id": self.tasks[0].task_id,
            "valid": True,
            "checks": {},
            "task_fingerprints": self.tasks[0].evaluation_fingerprints,
            "duration_s": 1.0,
        }

        validate_batch(
            self.tasks[:1],
            lambda task: self.repos[task.repo],
            results_root=self.root / "results",
            environment="docker",
        )

        self.assertEqual(validate.call_args.kwargs["environment"], "docker")

    @patch("selfbench.runner.validate_task")
    def test_batch_skips_currently_valid_tasks(self, validate) -> None:
        valid_result = {
            "result_schema_version": "harbor-1",
            "run_id": "earlier",
            "run_kind": "validation",
            "task_id": self.tasks[0].task_id,
            "valid": True,
            "checks": {},
            "task_fingerprints": self.tasks[0].evaluation_fingerprints,
            "duration_s": 1.0,
        }
        save_result(valid_result, self.root / "results", "validation")

        validate.return_value = valid_result
        outcomes = validate_batch(
            self.tasks,
            lambda task: self.repos[task.repo],
            results_root=self.root / "results",
        )

        self.assertIn("skipped", [o.status for o in outcomes])
        self.assertEqual(validate.call_count, 2)

    @patch("selfbench.runner.validate_task")
    def test_batch_surfaces_per_task_errors(self, validate) -> None:
        def _boom(task, local_repo, **kwargs):  # noqa: ARG001 - mock forwards all kwargs
            if task.task_id == self.tasks[0].task_id:
                raise RuntimeError("Modal authentication failed")
            return {
                "result_schema_version": "harbor-1",
                "run_id": f"run-{task.task_id}",
                "run_kind": "validation",
                "task_id": task.task_id,
                "valid": True,
                "checks": {},
                "task_fingerprints": task.evaluation_fingerprints,
                "duration_s": 1.0,
            }

        validate.side_effect = _boom
        outcomes = validate_batch(
            self.tasks,
            lambda task: self.repos[task.repo],
            results_root=self.root / "results",
        )

        error = next(o for o in outcomes if o.status == "error")
        self.assertEqual(error.exit_code, 2)
        self.assertIn("Modal authentication failed", error.error)
        self.assertIn("valid", [o.status for o in outcomes])

        # Saves are still written for the successes.
        self.assertTrue((self.root / "results" / self.tasks[1].task_id / "validation" / "result.json").is_file())

    @patch("selfbench.runner.validate_task")
    def test_batch_writes_per_task_logs(self, validate) -> None:
        validate.side_effect = [
            {
                "result_schema_version": "harbor-1",
                "run_id": f"run-{task.task_id}",
                "run_kind": "validation",
                "task_id": task.task_id,
                "valid": True,
                "checks": {},
                "task_fingerprints": task.evaluation_fingerprints,
                "duration_s": 1.0,
            }
            for task in self.tasks
        ]

        log_dir = self.root / "logs"
        validate_batch(
            self.tasks,
            lambda task: self.repos[task.repo],
            results_root=self.root / "results",
            log_dir=log_dir,
        )

        self.assertTrue(log_dir.is_dir())
        for task in self.tasks:
            self.assertTrue((log_dir / f"{task.task_id}.log").is_file())


class HarborCommandTest(unittest.TestCase):
    """The modal default must reach the harbor CLI as `--env modal`."""

    @patch("selfbench.harbor.load_harbor_run")
    @patch("selfbench.harbor.subprocess.run")
    @patch("selfbench.harbor._require_harbor")
    def test_run_harbor_task_passes_env_modal_flag(self, _load, run, require) -> None:
        from pathlib import Path as P

        require.return_value = P("/usr/local/bin/harbor")
        run.return_value.returncode = 0

        from selfbench.harbor import run_harbor_task

        with tempfile.TemporaryDirectory() as raw:
            task_dir = Path(raw) / "harbor-tasks" / "task"
            task_dir.mkdir(parents=True)
            jobs = Path(raw) / "jobs"
            run_harbor_task(task_dir, jobs, agent="nop", environment="modal", quiet=True)

        argv = run.call_args.args[0]
        self.assertIn("--env", argv)
        self.assertEqual(argv[argv.index("--env") + 1], "modal")

    @patch("selfbench.harbor.load_harbor_run")
    @patch("selfbench.harbor.subprocess.run")
    @patch("selfbench.harbor._require_harbor")
    def test_run_harbor_task_passes_env_docker_flag(self, _load, run, require) -> None:
        from pathlib import Path as P

        require.return_value = P("/usr/local/bin/harbor")
        run.return_value.returncode = 0

        from selfbench.harbor import run_harbor_task

        with tempfile.TemporaryDirectory() as raw:
            task_dir = Path(raw) / "harbor-tasks" / "task"
            task_dir.mkdir(parents=True)
            jobs = Path(raw) / "jobs"
            run_harbor_task(task_dir, jobs, agent="nop", environment="docker", quiet=True)

        argv = run.call_args.args[0]
        self.assertEqual(argv[argv.index("--env") + 1], "docker")

    @patch("selfbench.harbor.load_harbor_run")
    @patch("selfbench.harbor.subprocess.run")
    @patch("selfbench.harbor._require_harbor")
    def test_run_harbor_task_writes_log_when_requested(self, _load, run, require) -> None:
        from pathlib import Path as P

        require.return_value = P("/usr/local/bin/harbor")
        run.return_value.returncode = 0

        from selfbench.harbor import run_harbor_task

        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            task_dir = root / "harbor-tasks" / "task"
            task_dir.mkdir(parents=True)
            log_path = root / "logs" / "task.log"
            run_harbor_task(task_dir, root / "jobs", agent="nop", environment="modal", quiet=True, log_path=log_path)
            self.assertTrue(log_path.is_file())


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


class CliPathTest(unittest.TestCase):
    def test_model_slug_keeps_model_tail_and_rejects_path_unsafe_provider(self) -> None:
        self.assertEqual(_model_slug("openai", "org/model"), "openai__model")
        with self.assertRaisesRegex(ValueError, "provider"):
            _model_slug("../provider", "model")


class InfrastructureErrorSurfacingTest(unittest.TestCase):
    def test_validation_result_records_trial_exceptions(self) -> None:
        from selfbench.harbor import validation_result

        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            task_dir = root / "task"
            task_dir.mkdir()
            (task_dir / "prompt.md").write_text("Fix the behavior.")
            (task_dir / "test.patch").write_text("test patch")
            (task_dir / "gold.patch").write_text("gold patch")
            task = Task(
                task_id="infra-task",
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
            base = _fake_run(root / "base", {"fail_to_pass": 0, "pass_to_pass": 1})
            oracle = _fake_run(root / "oracle", {})
            oracle.trial_result["exception_info"] = {
                "exception_type": "RemoteError",
                "exception_message": "Image build failed",
            }

            result = validation_result(task, base, oracle)

        self.assertFalse(result["valid"])
        self.assertEqual(
            result["infrastructure_errors"], {"oracle": "RemoteError: Image build failed"}
        )

    def test_validation_result_omits_key_without_exceptions(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            task_dir = root / "task"
            task_dir.mkdir()
            (task_dir / "prompt.md").write_text("Fix the behavior.")
            (task_dir / "test.patch").write_text("test patch")
            (task_dir / "gold.patch").write_text("gold patch")
            task = Task(
                task_id="ok-task",
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
            from selfbench.harbor import validation_result

            base = _fake_run(root / "base", {"fail_to_pass": 0, "pass_to_pass": 1})
            oracle = _fake_run(
                root / "oracle",
                {"fail_to_pass": 1, "pass_to_pass": 1, "deterministic": 1, "patch_applied": 1},
            )
            result = validation_result(task, base, oracle)

        self.assertTrue(result["valid"])
        self.assertNotIn("infrastructure_errors", result)


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


class SelfbenchPiAgentConfigTest(unittest.TestCase):
    def test_thinking_enum_matches_pinned_pi_package(self) -> None:
        from selfbench.harbor_pi import SelfbenchPi

        flags = {flag.kwarg: flag.choices for flag in SelfbenchPi.CLI_FLAGS}
        self.assertIn("max", flags["thinking"])
        self.assertIn("xhigh", flags["thinking"])

    def test_models_json_payload_is_validated(self) -> None:
        import asyncio

        from selfbench.harbor_pi import MODELS_JSON_FILE_ENV, SelfbenchPi

        with tempfile.TemporaryDirectory() as raw_dir:
            bad = Path(raw_dir) / "models.json"
            bad.write_text("{not json")
            with patch.dict("os.environ", {MODELS_JSON_FILE_ENV: str(bad)}):
                agent = SelfbenchPi.__new__(SelfbenchPi)
                with self.assertRaises(json.JSONDecodeError):
                    asyncio.run(agent._install_models_json(object()))
