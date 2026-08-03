"""CLI-level tests for default execution environments and batch argument handling."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from selfbench.cli import _positive_int, build_parser, cmd_run, cmd_validate, cmd_validate_batch


def _valid_result(task_id: str, run_id: str, *, valid: bool = True) -> dict:
    return {
        "result_schema_version": "harbor-1",
        "run_id": run_id,
        "run_kind": "validation",
        "task_id": task_id,
        "valid": valid,
        "checks": {},
        "duration_s": 1.0,
        "resolved": valid,
        "failure_reasons": [],
        "fail_to_pass_passed": valid,
        "pass_to_pass_passed": valid,
        "agent_exit_ok": True,
        "agent_patch_applied": valid,
        "agent_patch": "",
        "task_fingerprints": {},
    }


class CliEnvironmentDefaultTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.task_dir = self.root / "task"
        self.task_dir.mkdir()
        (self.task_dir / "prompt.md").write_text("Fix the observable behavior.")
        (self.task_dir / "test.patch").write_text("test patch")
        (self.task_dir / "gold.patch").write_text("gold patch")
        (self.task_dir / "task.json").write_text(
            json.dumps(
                {
                    "task_id": "example-task",
                    "repo": "example/repo",
                    "base_commit": "abc123",
                    "workdir": ".",
                    "setup_cmd": "setup",
                    "test_cmd": "run {tests}",
                    "fail_to_pass": ["f2p"],
                    "pass_to_pass": ["p2p"],
                    "test_paths": ["tests"],
                }
            )
        )
        self.repo = self.root / "repo"
        self.repo.mkdir()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _validate_args(self, env: str | None) -> SimpleNamespace:
        return SimpleNamespace(
            task_dir=str(self.task_dir),
            repo=str(self.repo),
            results=str(self.root / "results"),
            harbor_tasks=str(self.root / "harbor-tasks"),
            jobs=str(self.root / "harbor-jobs"),
            env=env,
            rebuild=False,
            quiet=True,
        )

    @patch("selfbench.cli.validate_task")
    def test_validate_without_env_defaults_to_modal(self, validate) -> None:
        validate.return_value = _valid_result("example-task", "run-1")

        rc = cmd_validate(self._validate_args(env=None))

        self.assertEqual(rc, 0)
        self.assertEqual(validate.call_args.kwargs["environment"], "modal")

    @patch("selfbench.cli.validate_task")
    def test_validate_explicit_docker_override_is_forwarded(self, validate) -> None:
        validate.return_value = _valid_result("example-task", "run-1")

        rc = cmd_validate(self._validate_args(env="docker"))

        self.assertEqual(rc, 0)
        self.assertEqual(validate.call_args.kwargs["environment"], "docker")

    @patch("selfbench.cli.run_task")
    def test_run_without_env_keeps_docker_default(self, run) -> None:
        result = _valid_result("example-task", "run-2")
        result.update({"thinking": None, "provider": "openai", "model": "gpt-test"})
        run.return_value = result

        args = SimpleNamespace(
            task_dir=str(self.task_dir),
            repo=str(self.repo),
            results=str(self.root / "results"),
            harbor_tasks=str(self.root / "harbor-tasks"),
            jobs=str(self.root / "harbor-jobs"),
            env=None,
            rebuild=False,
            quiet=True,
            provider="openai",
            model="gpt-test",
            thinking=None,
            agent="pi",
        )
        rc = cmd_run(args)

        self.assertEqual(rc, 0)
        self.assertEqual(run.call_args.kwargs["environment"], "docker")

    def test_parser_validate_env_flag_accepts_docker(self) -> None:
        parser = build_parser()
        ns = parser.parse_args(["validate", str(self.task_dir), "--repo", str(self.repo), "--env", "docker"])
        self.assertEqual(ns.env, "docker")


class CliBatchEnvironmentTest(unittest.TestCase):
    def test_validate_batch_env_defaults_to_modal(self) -> None:
        parser = build_parser()
        ns = parser.parse_args(["validate-batch", "tasks"])
        self.assertEqual(ns.env, "modal")

    def test_validate_batch_env_override(self) -> None:
        parser = build_parser()
        ns = parser.parse_args(["validate-batch", "tasks", "--env", "docker"])
        self.assertEqual(ns.env, "docker")

    def test_validate_batch_env_var_default(self) -> None:
        with patch.dict(os.environ, {"SELFBENCH_VALIDATION_ENV": "docker"}):
            parser = build_parser()
            ns = parser.parse_args(["validate-batch", "tasks"])
        self.assertEqual(ns.env, "docker")

    def test_validate_batch_concurrency_defaults_to_none_and_env_can_throttle(self) -> None:
        parser = build_parser()
        ns = parser.parse_args(["validate-batch", "tasks"])
        self.assertIsNone(ns.concurrency)

        with patch.dict(os.environ, {"SELFBENCH_VALIDATION_CONCURRENCY": "4"}):
            parser = build_parser()
            ns = parser.parse_args(["validate-batch", "tasks"])
        self.assertEqual(ns.concurrency, 4)

    def test_validate_batch_rejects_invalid_concurrency(self) -> None:
        with patch.dict(os.environ, {"SELFBENCH_VALIDATION_CONCURRENCY": "not-a-number"}):
            parser = build_parser()
            with self.assertRaises(SystemExit):
                parser.parse_args(["validate-batch", "tasks"])

    def test_positive_int_rejects_zero_and_negative(self) -> None:
        for bad in ("0", "-1", "x"):
            with self.assertRaises(Exception):
                _positive_int(bad)
        self.assertEqual(_positive_int("7"), 7)


class CliBatchRunTest(unittest.TestCase):
    def test_cmd_validate_batch_reports_no_tasks(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            args = SimpleNamespace(
                task_dirs=[str(root)],
                results=str(root / "results"),
                harbor_tasks=str(root / "harbor-tasks"),
                jobs=str(root / "harbor-jobs"),
                logs=str(root / "logs"),
                env="modal",
                concurrency=None,
                repo_map=None,
                repos_root=None,
            )
            self.assertEqual(cmd_validate_batch(args), 1)

    def test_cmd_validate_batch_without_repos_fails_with_clear_message(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            task_dir = root / "task"
            task_dir.mkdir()
            (task_dir / "prompt.md").write_text("Fix the observable behavior.")
            (task_dir / "test.patch").write_text("test patch")
            (task_dir / "gold.patch").write_text("gold patch")
            (task_dir / "task.json").write_text(
                json.dumps(
                    {
                        "task_id": "example-task",
                        "repo": "example/repo",
                        "base_commit": "abc123",
                        "workdir": ".",
                        "setup_cmd": "setup",
                        "test_cmd": "run {tests}",
                        "fail_to_pass": ["f2p"],
                        "pass_to_pass": ["p2p"],
                        "test_paths": ["tests"],
                    }
                )
            )
            args = SimpleNamespace(
                task_dirs=[str(task_dir)],
                results=str(root / "results"),
                harbor_tasks=str(root / "harbor-tasks"),
                jobs=str(root / "harbor-jobs"),
                logs=str(root / "logs"),
                env="modal",
                concurrency=None,
                repo_map=None,
                repos_root=None,
            )
            self.assertEqual(cmd_validate_batch(args), 1)

    @patch("selfbench.cli.validate_batch")
    def test_cmd_validate_batch_defaults_concurrency_to_task_count(self, validate_batch) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            task_dir = root / "task"
            task_dir.mkdir()
            (task_dir / "prompt.md").write_text("Fix the observable behavior.")
            (task_dir / "test.patch").write_text("test patch")
            (task_dir / "gold.patch").write_text("gold patch")
            (task_dir / "task.json").write_text(
                json.dumps(
                    {
                        "task_id": "example-task",
                        "repo": "example/repo",
                        "base_commit": "abc123",
                        "workdir": ".",
                        "setup_cmd": "setup",
                        "test_cmd": "run {tests}",
                        "fail_to_pass": ["f2p"],
                        "pass_to_pass": ["p2p"],
                        "test_paths": ["tests"],
                    }
                )
            )
            validate_batch.return_value = [
                SimpleNamespace(status="valid", task_id="example-task", exit_code=0, error=None, result_path=None, as_dict=lambda: {"status": "valid"})
            ]
            args = SimpleNamespace(
                task_dirs=[str(task_dir)],
                results=str(root / "results"),
                harbor_tasks=str(root / "harbor-tasks"),
                jobs=str(root / "harbor-jobs"),
                logs=str(root / "logs"),
                env="modal",
                concurrency=None,
                repo_map=["example/repo=" + str(root / "repo")],
                repos_root=None,
            )
            (root / "repo").mkdir()
            self.assertEqual(cmd_validate_batch(args), 0)
            self.assertEqual(validate_batch.call_args.kwargs["concurrency"], 1)
            self.assertEqual(validate_batch.call_args.kwargs["environment"], "modal")


if __name__ == "__main__":
    unittest.main()
