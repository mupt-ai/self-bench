from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from selfbench.prompt_generation import build_generation_request, generate_prompt, save_generated_prompt
from selfbench.task import load_task


class PromptGenerationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.task_dir = Path(self.temp_dir.name)
        (self.task_dir / "inputs").mkdir()
        (self.task_dir / "inputs" / "session.json").write_text(json.dumps({"messages": [
            {"role": "user", "content": "The provider call times out and wipes my conversation."},
            {"role": "assistant", "content": "The activity timeout is currently thirty seconds. I opened PR #812 at https://github.com/example/project/pull/812."},
            {"role": "user", "content": "Only change the LLM call timeout, and keep the old conversation."},
        ]}))
        (self.task_dir / "prompt.md").write_text("Old synthetic prompt that must not enter generation context.")
        (self.task_dir / "test.patch").write_text("diff --git a/tests/x b/tests/x\n")
        (self.task_dir / "gold.patch").write_text("diff --git a/src/secret_solution.py b/src/secret_solution.py\n")
        (self.task_dir / "task.json").write_text(json.dumps({
            "task_id": "example",
            "repo": "example/project",
            "base_commit": "abc123",
            "workdir": ".",
            "setup_cmd": "true",
            "test_cmd": "test {tests}",
            "fail_to_pass": ["tests/x"],
            "pass_to_pass": ["tests/y"],
            "test_paths": ["tests"],
            "trace_source": {"path": "inputs/session.json", "format": "generic"},
        }))

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_generation_request_uses_conversation_without_existing_solution_artifacts(self) -> None:
        request = build_generation_request(load_task(self.task_dir))

        self.assertIn("The provider call times out", request)
        self.assertIn("Only change the LLM call timeout", request)
        self.assertIn("The activity timeout is currently thirty seconds", request)
        self.assertNotIn("PR #812", request)
        self.assertNotIn("github.com/example/project/pull/812", request)
        self.assertNotIn("Old synthetic prompt", request)
        self.assertNotIn("secret_solution.py", request)

    @patch("selfbench.prompt_generation.subprocess.run")
    def test_generator_process_cannot_access_repo_tools(self, run_mock) -> None:
        prompt = " ".join(["Please investigate and fix the reported behavior without changing unrelated paths."] * 7)
        run_mock.return_value.returncode = 0
        run_mock.return_value.stdout = prompt
        run_mock.return_value.stderr = ""

        generate_prompt(
            load_task(self.task_dir),
            provider="openai",
            model="gpt-test",
            pi_executable="/fake/pi",
        )

        command = run_mock.call_args.args[0]
        self.assertIn("--no-tools", command)
        self.assertIn("--no-extensions", command)
        self.assertIn("--no-context-files", command)

    def test_save_records_prompt_generation_fingerprint(self) -> None:
        prompt = (
            "When an LLM call takes longer than the current activity timeout, the turn fails and my existing "
            "conversation disappears. Please give the provider call enough time to finish and preserve the "
            "conversation state that existed before the failed turn. This should apply specifically to the LLM "
            "call path rather than broadly changing unrelated activity behavior. If the call still times out, "
            "return an error that explains what actually timed out instead of exposing raw workflow-engine text."
        )
        task = load_task(self.task_dir)

        save_generated_prompt(
            task,
            prompt,
            provider="openai",
            model="gpt-test",
            request_sha256="request-hash",
        )
        reloaded = load_task(self.task_dir)

        self.assertEqual(reloaded.prompt, prompt + "\n")
        self.assertEqual(reloaded.prompt_generation["generator_version"], "user-voice-v1")
        self.assertEqual(reloaded.prompt_generation["human_turn_indices"], [0, 1])
        self.assertTrue(reloaded.prompt_generation["assistant_context_used"])
        self.assertEqual(reloaded.prompt_generation["prompt_sha256"], reloaded.prompt_sha256)


if __name__ == "__main__":
    unittest.main()
