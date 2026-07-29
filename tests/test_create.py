"""Tests for the selfbench create subcommand (Pi wrapper)."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from selfbench.create import build_create_request, launch_create_agent


class BuildCreateRequestTest(unittest.TestCase):
    def test_minimal_default(self) -> None:
        result = build_create_request([])
        lines = result.split("\n")
        self.assertIn("Use the loaded selfbench skill", lines[0])
        self.assertIn("Write authoring artifacts under:", lines[1])

    def test_no_request_triggers_autonomous_pr_discovery(self) -> None:
        result = build_create_request([])
        self.assertIn("No pull request is preselected", result)
        self.assertIn("merged pull requests", result)
        self.assertIn("existing tasks and rejected candidates", result)
        self.assertIn("Do not ask me to nominate PR numbers", result)

    def test_creation_allows_validation_but_stops_before_solver_trials(self) -> None:
        result = build_create_request([])
        self.assertIn("deterministic nop/oracle validation and static audit are allowed", result)
        self.assertIn("Do not run benchmark solver trials", result)
        self.assertIn("never invoke selfbench run", result)
        self.assertIn("coding agent/model unless the user explicitly asks", result)

    def test_joins_request_segments(self) -> None:
        result = build_create_request(["Create", "a task", "from PR 42"])
        self.assertIn("Create a task from PR 42", result)
        self.assertNotIn("No pull request is preselected", result)

    def test_repo_path_appears_in_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            result = build_create_request(["Fix the bug"], repo=Path(d))
            self.assertIn(f"Source repository: {Path(d).resolve()}", result)

    def test_repo_must_exist(self) -> None:
        with self.assertRaises(ValueError):
            build_create_request(["hi"], repo=Path("/nonexistent-dir-please-ignore"))

    def test_tasks_root_customization(self) -> None:
        result = build_create_request([], tasks_root=Path("my-tasks"))
        self.assertIn("my-tasks", result)

    def test_count_sets_explicit_batch_target(self) -> None:
        result = build_create_request([], count=4)
        self.assertIn("Target batch size: 4", result)
        self.assertIn("exactly 4 complete benchmark task directories", result)

    def test_count_must_be_positive(self) -> None:
        with self.assertRaisesRegex(ValueError, "positive integer"):
            build_create_request([], count=0)


class LaunchCreateAgentTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @patch("selfbench.create.subprocess.run")
    def test_launches_pi_with_skill_argv(self, run_mock) -> None:
        run_mock.return_value.returncode = 0

        code = launch_create_agent(
            ["Create a task from the latest changes"],
            repo=self.root,
            provider="openai",
            model="gpt-4o",
            thinking="high",
            print_mode=True,
        )

        self.assertEqual(code, 0)
        self.assertEqual(run_mock.call_count, 1)
        (args, kwargs) = run_mock.call_args
        command: list[str] = args[0]
        # Should find --skill, --provider, --model, --thinking, --print, then the prompt
        self.assertIn("--skill", command)
        self.assertIn("--provider", command)
        self.assertIn("--model", command)
        self.assertIn("--thinking", command)
        self.assertIn("--print", command)
        self.assertIn(self.root.name, " ".join(command))

    @patch("selfbench.create.subprocess.run")
    def test_count_is_forwarded_in_prompt(self, run_mock) -> None:
        run_mock.return_value.returncode = 0

        launch_create_agent([], count=3, print_mode=True)

        prompt = run_mock.call_args.args[0][-1]
        self.assertIn("Target batch size: 3", prompt)

    @patch("selfbench.create.subprocess.run")
    def test_respects_custom_pi_executable(self, run_mock) -> None:
        run_mock.return_value.returncode = 0

        launch_create_agent(
            ["hello"],
            pi_executable="/custom/pi",
            print_mode=True,
        )

        command = run_mock.call_args.args[0]
        self.assertEqual(command[0], "/custom/pi")

    @patch("selfbench.create.subprocess.run")
    def test_respects_custom_skill_path(self, run_mock) -> None:
        run_mock.return_value.returncode = 0

        custom = self.root / "my-skill.md"
        custom.write_text("# custom skill")
        launch_create_agent(["test"], skill_path=custom, print_mode=True)

        command = run_mock.call_args.args[0]
        idx = command.index("--skill")
        self.assertEqual(Path(command[idx + 1]).resolve(), custom.resolve())

    @patch("selfbench.create.subprocess.run", side_effect=FileNotFoundError("no pi"))
    def test_raises_useful_error_when_pi_not_found(self, run_mock) -> None:
        with self.assertRaisesRegex(RuntimeError, "Install Pi"):
            launch_create_agent(["test"], print_mode=True)

    @patch("selfbench.create.subprocess.run")
    def test_default_is_interactive(self, run_mock) -> None:
        run_mock.return_value.returncode = 0
        launch_create_agent(["hello"])
        command = run_mock.call_args.args[0]
        # --print must not appear
        self.assertNotIn("--print", command)

    @patch("selfbench.create.subprocess.run")
    def test_no_provider_model_omitted(self, run_mock) -> None:
        run_mock.return_value.returncode = 0
        launch_create_agent(["hello"], print_mode=True)
        command = run_mock.call_args.args[0]
        self.assertNotIn("--provider", command)
        self.assertNotIn("--model", command)
        self.assertNotIn("--thinking", command)

    @patch("selfbench.create.subprocess.run")
    def test_repo_path_shows_in_prompt_not_in_argv_flag(self, run_mock) -> None:
        run_mock.return_value.returncode = 0
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d)
            launch_create_agent(["fix the thing"], repo=repo, print_mode=True)
        cmd = run_mock.call_args.args[0]
        # No --repo flag on the Pi command line
        self.assertNotIn("--repo", cmd)
        # The prompt is the last positional argument (after all flags and their values)
        prompt = cmd[-1]
        self.assertIn(repo.name, prompt)


if __name__ == "__main__":
    unittest.main()
