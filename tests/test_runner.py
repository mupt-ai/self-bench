from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from selfbench.cli import _harbor_run_command, _iter_task_dirs, build_parser
from selfbench.harbor import HarborRun, build_harbor_task
from selfbench.harbor_pi import PI_VERSION, _provider_error
from selfbench.runner import (
    DEFAULT_VALIDATION_ENVIRONMENT,
    BatchValidationOutcome,
    is_currently_valid,
    save_result,
    validate_batch,
    validate_task,
)
from selfbench.task import DEFAULT_TOOLCHAINS, Task

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

    def test_pins_the_snapshot_corepack_package_manager(self) -> None:
        (self.repo / "package.json").write_text('{"packageManager":"pnpm@9.6.0"}\n')
        subprocess.run(["git", "-C", str(self.repo), "add", "package.json"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-qm", "pin pnpm"], check=True)
        self.task.base_commit = subprocess.run(
            ["git", "-C", str(self.repo), "rev-parse", "HEAD"],
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()

        output = build_harbor_task(self.task, self.repo, self.root / "harbor-tasks")

        dockerfile = (output / "environment" / "Dockerfile").read_text()
        manifest = json.loads((output / ".selfbench-manifest.json").read_text())
        self.assertIn("COREPACK_HOME=/usr/local/share/corepack", dockerfile)
        self.assertIn("corepack prepare pnpm@9.6.0 --activate", dockerfile)
        self.assertEqual(manifest["package_manager"], "pnpm@9.6.0")


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


class EnvironmentDefaultTest(unittest.TestCase):
    """Validation defaults to Modal and accepts a Docker override."""

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
    def test_repeated_setup_failures_block_remaining_repo_tasks(self, validate) -> None:
        for task in self.tasks:
            task.repo = "example/shared"

        def setup_failure(task, local_repo, **kwargs):  # noqa: ARG001 - mock forwards all kwargs
            return {
                "result_schema_version": "harbor-1",
                "run_id": f"run-{task.task_id}",
                "run_kind": "validation",
                "task_id": task.task_id,
                "valid": False,
                "checks": {},
                "setup_failures": {"oracle": "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH"},
                "task_fingerprints": task.evaluation_fingerprints,
                "duration_s": 1.0,
            }

        validate.side_effect = setup_failure
        outcomes = validate_batch(
            self.tasks,
            lambda task: self.root / "repo",
            results_root=self.root / "results",
            environment="modal",
            concurrency=1,
        )

        self.assertEqual(validate.call_count, 2)
        self.assertEqual([outcome.status for outcome in outcomes].count("blocked"), 1)
        blocked = next(outcome for outcome in outcomes if outcome.status == "blocked")
        self.assertEqual(blocked.setup_failure_signature, "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH")

    @patch("selfbench.runner.preflight_harbor_task")
    @patch("selfbench.runner.build_harbor_task", return_value=Path("/tmp/harbor-task"))
    @patch("selfbench.runner.validate_task")
    def test_preflight_builds_images_before_remote_validation(self, validate, build, preflight) -> None:
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
            environment="modal",
            preflight=True,
        )

        build.assert_called_once()
        preflight.assert_called_once_with(Path("/tmp/harbor-task"), log_path=None)
        self.assertFalse(validate.call_args.kwargs["rebuild"])

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


class HarborNativeCommandTest(unittest.TestCase):
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


class HarborCommandTest(unittest.TestCase):
    def test_cli_does_not_expose_run_or_report_commands(self) -> None:
        commands = build_parser()._subparsers._group_actions[0].choices

        self.assertNotIn("run", commands)
        self.assertNotIn("report", commands)

    def test_uses_harbor_pi_with_sol_and_xhigh(self) -> None:
        command = _harbor_run_command(Path("harbor-tasks/example task"))

        self.assertIn("harbor run", command)
        self.assertIn("--agent pi", command)
        self.assertIn("openai/gpt-5.6-sol", command)
        self.assertIn("thinking=xhigh", command)
        self.assertIn("api.openai.com", command)
        self.assertIn("'harbor-tasks/example task'", command)
        self.assertTrue(command.startswith("harbor run "))
        self.assertNotIn("uv run harbor", command)
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

    def test_validation_result_records_setup_failure_signature(self) -> None:
        from selfbench.harbor import validation_result

        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            task_dir = root / "task"
            task_dir.mkdir()
            (task_dir / "prompt.md").write_text("Fix the behavior.")
            (task_dir / "test.patch").write_text("test patch")
            (task_dir / "gold.patch").write_text("gold patch")
            task = Task(
                task_id="setup-task", repo="example/repo", base_commit="abc123", workdir=".",
                setup_cmd="setup", test_cmd="run {tests}", fail_to_pass=["f2p"],
                pass_to_pass=["p2p"], test_paths=["tests"], dir=task_dir,
            )
            base = _fake_run(root / "base", {"patch_applied": 1, "setup_completed": 0})
            oracle = _fake_run(root / "oracle", {"patch_applied": 1, "setup_completed": 0})
            for run in (base, oracle):
                verifier = run.trial_dir / "verifier"
                verifier.mkdir()
                (verifier / "test-stdout.txt").write_text("ERR_PNPM_LOCKFILE_CONFIG_MISMATCH\n")

            result = validation_result(task, base, oracle)

        self.assertEqual(
            result["setup_failures"],
            {
                "base": "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH",
                "oracle": "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH",
            },
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


class SealedAgentNetworkTest(unittest.TestCase):
    """The agent works the task offline except for its model provider."""

    def _task(self, task_dir: Path, **overrides) -> Task:
        (task_dir / "prompt.md").write_text("Fix the behavior.")
        (task_dir / "test.patch").write_text("test patch")
        (task_dir / "gold.patch").write_text("gold patch")
        return Task(
            task_id="sealed", repo="example/repo", base_commit="abc123", workdir=".",
            setup_cmd="setup", test_cmd="run {tests}", fail_to_pass=["f2p"],
            pass_to_pass=["p2p"], test_paths=["tests"], dir=task_dir, **overrides,
        )

    def test_defaults_seal_agent_and_verifier_phases(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            t = self._task(Path(raw))
        self.assertEqual(t.agent_network_mode, "allowlist")
        self.assertEqual(t.agent_allowed_hosts, [])
        self.assertEqual(t.verifier_network_mode, "public")

    def test_task_toml_emits_phase_policies(self) -> None:
        from selfbench.harbor import _task_toml

        with tempfile.TemporaryDirectory() as raw:
            t = self._task(Path(raw), agent_allowed_hosts=["api.example.com"])
            toml = _task_toml(t, "sealed")
        self.assertIn("[agent]", toml)
        self.assertIn('network_mode = "allowlist"', toml)
        self.assertIn('"api.example.com"', toml)
        self.assertIn("[verifier]", toml)


class ConfigurableToolchainTest(unittest.TestCase):
    def _task(self, task_dir: Path, **kw) -> Task:
        (task_dir / "prompt.md").write_text("Fix it.")
        (task_dir / "test.patch").write_text("t")
        (task_dir / "gold.patch").write_text("g")
        return Task(
            task_id="tc", repo="e/r", base_commit="abc", workdir=".", setup_cmd="s",
            test_cmd="r {tests}", fail_to_pass=["a"], pass_to_pass=["b"],
            test_paths=["tests"], dir=task_dir, **kw,
        )

    def test_default_installs_historical_set(self) -> None:
        from selfbench.harbor import _toolchain_layers

        d = _toolchain_layers(None)
        self.assertEqual(DEFAULT_TOOLCHAINS, ("uv", "bun", "go", "node"))
        for marker in ("astral.sh/uv", "bun.sh/install", "go.dev/dl", "nodejs.org"):
            self.assertIn(marker, d)
        self.assertNotIn("rustup.rs", d)

    def test_subset_omits_unused_toolchains(self) -> None:
        from selfbench.harbor import _toolchain_layers

        d = _toolchain_layers(["uv", "rust"])
        self.assertIn("rustup.rs", d)
        self.assertNotIn("go.dev/dl", d)
        self.assertNotIn("nodejs.org", d)

    def test_unknown_toolchain_rejected(self) -> None:
        from selfbench.harbor import _toolchain_layers

        with self.assertRaisesRegex(ValueError, "unknown toolchain"):
            _toolchain_layers(["cobol"])

    def test_default_task_keeps_its_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            plain = self._task(Path(raw))
            explicit = self._task(Path(raw), toolchains=["uv", "rust"])
            self.assertNotIn("toolchains", json.dumps(plain.evaluation_fingerprints))
            self.assertNotEqual(
                plain.evaluation_fingerprints["definition_sha256"],
                explicit.evaluation_fingerprints["definition_sha256"],
            )

    def test_toolchain_order_does_not_change_the_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            first = self._task(Path(raw), toolchains=["python"])
            second = self._task(Path(raw), toolchains=["uv", "python"])
            self.assertEqual(first.evaluation_fingerprints, second.evaluation_fingerprints)

    def test_dockerfiles_use_the_task_selection(self) -> None:
        from selfbench.harbor import _environment_dockerfile, _verifier_dockerfile

        with tempfile.TemporaryDirectory() as raw:
            t = self._task(Path(raw), toolchains=["uv", "rust"])
            for df in (_environment_dockerfile(t), _verifier_dockerfile(t)):
                self.assertIn("rustup.rs", df)
                self.assertNotIn("go.dev/dl", df)


class PythonToolchainTest(unittest.TestCase):
    def test_python_toolchain_installs_interpreters(self) -> None:
        from selfbench.harbor import _toolchain_layers

        d = _toolchain_layers(["uv", "python"])
        self.assertIn("uv python install", d)
        self.assertIn("UV_PYTHON_INSTALL_DIR", d)
        self.assertIn("/usr/local/bin/python3.12 /usr/local/bin/python", d)

    def test_python_includes_uv(self) -> None:
        from selfbench.harbor import _toolchain_layers

        dockerfile = _toolchain_layers(["python"])
        self.assertIn("astral.sh/uv/install.sh", dockerfile)
        self.assertIn("uv python install", dockerfile)

    def test_uv_is_installed_before_python_regardless_of_order(self) -> None:
        from selfbench.harbor import _toolchain_layers

        d = _toolchain_layers(["python", "uv"])
        self.assertLess(d.index("astral.sh/uv/install.sh"), d.index("uv python install"))


if __name__ == "__main__":
    unittest.main()
