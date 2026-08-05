from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from selfbench.agent_input import build_provenance_payload, build_provenance_staging, extract_prompt, extract_provenance_artifact, extract_trace


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

    def test_extracts_review_trace_without_injected_messages_or_secrets(self) -> None:
        path = self.write_jsonl(
            "pi.jsonl",
            [
                {"type": "session", "id": "s1"},
                {"type": "message", "parentId": None, "message": {"role": "user", "content": "Investigate this with dari_abcdefghijklmnopqrstuvwxyz1234"}},
                {"type": "message", "parentId": None, "message": {"role": "assistant", "content": [{"type": "text", "text": "I found the timeout."}]}},
                {"type": "message", "parentId": None, "message": {"role": "user", "content": "<skill name=\"loop-on-ci\">injected</skill>"}},
                {"type": "message", "parentId": None, "message": {"role": "user", "content": "Make the timeout ten minutes."}},
            ],
        )

        trace = extract_trace(path, source_format="auto")

        self.assertEqual(trace["format"], "pi")
        self.assertEqual(trace["messages"], [
            {"role": "user", "content": "Investigate this with dari_[REDACTED]", "user_message_index": 0},
            {"role": "assistant", "content": "I found the timeout."},
            {"role": "user", "content": "Make the timeout ten minutes.", "user_message_index": 1},
        ])
        self.assertEqual(extract_prompt(path, message_index=-1), "Make the timeout ten minutes.")

    def test_provenance_artifact_contains_only_selected_redacted_prompt(self) -> None:
        path = self.write_jsonl(
            "pi.jsonl",
            [
                {"type": "message", "parentId": None, "message": {"role": "user", "content": "Unrelated earlier request"}},
                {"type": "message", "parentId": None, "message": {"role": "assistant", "content": "Unrelated assistant response"}},
                {"type": "message", "parentId": None, "message": {"role": "toolResult", "content": "UNRELATED_RAW_SECRET"}},
                {"type": "message", "parentId": None, "message": {"role": "user", "content": "Fix it with sk-abcdefghijklmnopqrstuvwxyz1234"}},
            ],
        )

        artifact = extract_provenance_artifact(path, source_format="pi", message_index=1)
        encoded = json.dumps(artifact)

        self.assertEqual(artifact, {"messages": [{"role": "user", "content": "Fix it with sk-[REDACTED]"}]})
        self.assertNotIn("UNRELATED_RAW_SECRET", encoded)
        self.assertNotIn("Unrelated", encoded)
        self.assertNotIn("abcdefghijklmnopqrstuvwxyz1234", encoded)

    def test_provenance_payload_is_deterministic_generic_json(self) -> None:
        path = self.root / "prompt.json"
        path.write_text(json.dumps({"messages": [{"role": "user", "content": "Ship it"}]}))
        payload = build_provenance_payload(path)
        self.assertEqual(payload, b'{"messages":[{"content":"Ship it","role":"user"}]}')

    def test_provenance_staging_contract_rewrites_exact_bytes_hash_and_path(self) -> None:
        path = self.root / "prompt.json"
        path.write_text(json.dumps({"messages": [
            {"role": "user", "content": "Earlier request"},
            {"role": "user", "content": "Ship it"},
        ]}))
        payload, remote_path, rewritten = build_provenance_staging(
            path,
            run_id="run-1",
            worker_id="worker-1",
            artifact_mount="/artifacts",
            message_index=1,
        )
        checksum = "d124f9b7b0b452864d91f7197653a72c009bccb92b7f310acb118c95290f9068"
        self.assertEqual(payload, b'{"messages":[{"content":"Ship it","role":"user"}]}')
        self.assertEqual(remote_path, f"runs/run-1/inputs/worker-1/{checksum}.json")
        self.assertEqual(rewritten, {
            "path": f"/artifacts/{remote_path}",
            "format": "generic",
            "message_index": 0,
            "sha256": checksum,
        })

    def test_redacts_common_credential_families_from_selected_prompt(self) -> None:
        credentials = "\n".join([
            "Authorization: Bearer bearer-token-abcdefghijklmnopqrstuvwxyz",
            "AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP",
            "AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz/1234567890+ABCD",
            "npm_abcdefghijklmnopqrstuvwxyz123456",
            "glpat-abcdefghijklmnopqrstuvwxyz123456",
            "PASSWORD=hunter2-secret",
            "DATABASE_URL=postgresql://user:secret@db.example/app",
            "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
        ])
        path = self.root / "credentials.json"
        path.write_text(json.dumps({"messages": [{"role": "user", "content": credentials}]}))

        prompt = extract_prompt(path)

        for secret in (
            "bearer-token", "AKIAABCDEFGHIJKLMNOP", "abcdefghijklmnopqrstuvwxyz/1234567890+ABCD",
            "npm_abcdefghijklmnopqrstuvwxyz", "glpat-abcdefghijklmnopqrstuvwxyz", "hunter2-secret",
            "user:secret", "private-material",
        ):
            self.assertNotIn(secret, prompt)
        self.assertIn("[REDACTED PRIVATE KEY]", prompt)

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
