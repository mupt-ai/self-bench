from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from mysb.task import load_task


class TaskPromptSourceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.task_dir = Path(self.temp_dir.name)
        (self.task_dir / "inputs").mkdir()
        (self.task_dir / "test.patch").write_text("diff --git a/tests/x b/tests/x\n")
        (self.task_dir / "gold.patch").write_text("diff --git a/src/x b/src/x\n")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write_task(self, **overrides: object) -> None:
        config: dict[str, object] = {
            "task_id": "example",
            "repo": "example/project",
            "base_commit": "abc123",
            "workdir": ".",
            "setup_cmd": "true",
            "test_cmd": "test {tests}",
            "fail_to_pass": ["tests/x"],
            "pass_to_pass": ["tests/y"],
            "test_paths": ["tests"],
            "prompt_source": {"path": "inputs/session.json", "format": "generic", "message_index": -1},
        }
        config.update(overrides)
        (self.task_dir / "task.json").write_text(json.dumps(config))

    def test_loads_prompt_and_origin_from_agent_json(self) -> None:
        (self.task_dir / "inputs" / "session.json").write_text(json.dumps({"messages": [
            {"role": "user", "content": "First request"},
            {"role": "user", "content": "Engineer-authored request"},
        ]}))
        self.write_task()

        task = load_task(self.task_dir)

        self.assertEqual(task.prompt, "Engineer-authored request")
        self.assertEqual(task.prompt_origin, {
            "kind": "agent_json",
            "path": "inputs/session.json",
            "format": "generic",
            "message_index": -1,
        })

    def test_loads_trace_source_with_manual_prompt(self) -> None:
        (self.task_dir / "inputs" / "session.json").write_text(json.dumps({"messages": [
            {"role": "user", "content": "Original rough request"},
            {"role": "assistant", "content": "Implementation context"},
        ]}))
        (self.task_dir / "prompt.md").write_text("Standalone eval prompt")
        self.write_task(
            prompt_source=None,
            trace_source={"path": "inputs/session.json", "format": "generic"},
        )

        task = load_task(self.task_dir)

        self.assertEqual(task.prompt, "Standalone eval prompt")
        self.assertEqual(task.source_trace, {
            "origin": {"path": "inputs/session.json", "format": "generic"},
            "messages": [
                {"role": "user", "content": "Original rough request", "user_message_index": 0},
                {"role": "assistant", "content": "Implementation context"},
            ],
        })

    def test_rejects_prompt_file_and_prompt_source_together(self) -> None:
        (self.task_dir / "inputs" / "session.json").write_text(json.dumps({"messages": [{"role": "user", "content": "Request"}]}))
        (self.task_dir / "prompt.md").write_text("Duplicate request")
        self.write_task()

        with self.assertRaisesRegex(ValueError, "exactly one"):
            load_task(self.task_dir)

    def test_rejects_prompt_source_outside_task_directory(self) -> None:
        self.write_task(prompt_source={"path": "../session.json"})

        with self.assertRaisesRegex(ValueError, "inside the task directory"):
            load_task(self.task_dir)

    def test_rejects_trace_source_outside_task_directory(self) -> None:
        (self.task_dir / "prompt.md").write_text("Standalone eval prompt")
        self.write_task(prompt_source=None, trace_source={"path": "../session.json"})

        with self.assertRaisesRegex(ValueError, "trace_source.path must stay"):
            load_task(self.task_dir)

    def test_rejects_generated_prompt_when_fingerprint_changed(self) -> None:
        (self.task_dir / "prompt.md").write_text("Edited generated prompt")
        self.write_task(
            prompt_source=None,
            prompt_generation={"prompt_sha256": "old-fingerprint"},
        )

        with self.assertRaisesRegex(ValueError, "does not match prompt_generation"):
            load_task(self.task_dir)


if __name__ == "__main__":
    unittest.main()
