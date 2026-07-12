from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from mysb.agent_input import extract_prompt


class AgentInputTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write_jsonl(self, name: str, records: list[dict[str, object]]) -> Path:
        path = self.root / name
        path.write_text("".join(json.dumps(record) + "\n" for record in records))
        return path

    def test_extracts_codex_user_events_without_injected_context(self) -> None:
        path = self.write_jsonl(
            "codex.jsonl",
            [
                {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "# AGENTS.md instructions\ninternal"}]}},
                {"type": "event_msg", "payload": {"type": "user_message", "message": "Fix the retry race."}},
                {"type": "event_msg", "payload": {"type": "user_message", "message": "Keep the old API working."}},
            ],
        )

        self.assertEqual(extract_prompt(path, source_format="codex"), "Fix the retry race.")
        self.assertEqual(
            extract_prompt(path, source_format="auto", message_index=-1),
            "Keep the old API working.",
        )

    def test_extracts_claude_code_external_user_messages(self) -> None:
        path = self.write_jsonl(
            "claude.jsonl",
            [
                {"type": "user", "sessionId": "s1", "message": {"role": "user", "content": "Add cancellation support."}},
                {"type": "user", "sessionId": "s1", "sourceToolAssistantUUID": "tool-1", "message": {"role": "user", "content": [{"type": "tool_result", "content": "ignore"}]}},
            ],
        )

        self.assertEqual(extract_prompt(path, source_format="auto"), "Add cancellation support.")

    def test_extracts_pi_text_blocks(self) -> None:
        path = self.write_jsonl(
            "pi.jsonl",
            [
                {"type": "session", "id": "s1"},
                {"type": "message", "parentId": None, "message": {"role": "user", "content": [{"type": "text", "text": "Make builds deterministic."}]}},
            ],
        )

        self.assertEqual(extract_prompt(path, source_format="auto"), "Make builds deterministic.")

    def test_extracts_generic_messages_json(self) -> None:
        path = self.root / "generic.json"
        path.write_text(json.dumps({"messages": [{"role": "system", "content": "ignore"}, {"role": "user", "content": [{"type": "text", "text": "Support zero as a limit."}]}]}))

        self.assertEqual(extract_prompt(path), "Support zero as a limit.")

    def test_rejects_out_of_range_message_index(self) -> None:
        path = self.root / "generic.json"
        path.write_text(json.dumps({"messages": [{"role": "user", "content": "Only prompt"}]}))

        with self.assertRaisesRegex(ValueError, "out of range"):
            extract_prompt(path, message_index=1)


if __name__ == "__main__":
    unittest.main()
