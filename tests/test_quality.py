from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from selfbench.quality import (
    _brittle_test_signals,
    _gold_coupled_test_identifiers,
    _model_results,
    _validation_status,
    audit_task,
)
from selfbench.result_schema import RESULT_SCHEMA_VERSION
from selfbench.task import Task


class GoldCouplingTest(unittest.TestCase):
    def test_detects_tests_that_require_gold_patch_internal_names(self) -> None:
        gold_patch = """\
+    rollback_snapshot_ref: SnapshotRef | None = None
+    async def _rollback_runtime_snapshot(self) -> None:
+        pass
+_PRIVATE_ROLLBACK_LIMIT = 10
+"""
        test_patch = """\
+    result = TurnResult(rollback_snapshot_ref=previous)
+    assert result.rollback_snapshot_ref == previous
+    monkeypatch.setattr(service, \"_rollback_runtime_snapshot\", fail)
+    assert module._PRIVATE_ROLLBACK_LIMIT == 10
+"""

        private_names, field_names = _gold_coupled_test_identifiers(
            test_patch,
            gold_patch,
            "Keep the conversation after a failed turn.",
        )

        self.assertEqual(
            private_names,
            ["_PRIVATE_ROLLBACK_LIMIT", "_rollback_runtime_snapshot"],
        )
        self.assertEqual(field_names, ["rollback_snapshot_ref"])

    def test_detects_unprompted_gold_field_used_as_json_key(self) -> None:
        private_names, field_names = _gold_coupled_test_identifiers(
            "+    assert response.json() == {'auth_subject': 'usr_123'}\n",
            "+    auth_subject: str\n",
            "Return the verified identity claims.",
        )

        self.assertEqual(private_names, [])
        self.assertEqual(field_names, ["auth_subject"])

    def test_flags_magic_byte_offset_assertions(self) -> None:
        warnings = _brittle_test_signals(
            "+    assert int.from_bytes(archive[4:8], 'little') == 0\n"
        )

        self.assertTrue(any("fixed byte offset" in warning for warning in warnings))

    def test_allows_identifier_when_public_interface_is_in_prompt(self) -> None:
        private_names, field_names = _gold_coupled_test_identifiers(
            "+    assert result.public_result_status == 'ready'\n",
            "+    public_result_status: str = 'ready'\n",
            "Add the public_result_status field to the result.",
        )

        self.assertEqual(private_names, [])
        self.assertEqual(field_names, [])


class RequestProvenanceTest(unittest.TestCase):
    def test_rejects_task_reconstructed_without_authentic_request_source(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            task_dir = Path(raw_dir)
            (task_dir / "prompt.md").write_text(" ".join(["behavior"] * 100))
            (task_dir / "test.patch").write_text(
                "diff --git a/tests/x.py b/tests/x.py\n+def test_behavior(): pass\n"
            )
            (task_dir / "gold.patch").write_text(
                "diff --git a/src/x.py b/src/x.py\n+def behavior(): pass\n"
            )
            task = Task(
                task_id="no-source",
                repo="example/repo",
                base_commit="abc123",
                workdir=".",
                setup_cmd="true",
                test_cmd="pytest {tests}",
                fail_to_pass=["tests/x.py::test_behavior"],
                pass_to_pass=["tests/a.py", "tests/b.py", "tests/c.py"],
                test_paths=["tests"],
                dir=task_dir,
            )

            audit = audit_task(task, task_dir / "results", [])

        self.assertTrue(
            any("authentic request provenance" in blocker for blocker in audit.blockers)
        )


class ModelResultFreshnessTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.results = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write_result(self, slug: str, **values: object) -> None:
        path = self.results / "task" / slug / "result.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(values))

    def test_marks_result_stale_when_generated_prompt_fingerprint_changed(self) -> None:
        self.write_result("model", resolved=True, prompt_sha256="old")

        results = _model_results(
            self.results,
            "task",
            ["model"],
            required_prompt_sha256="current",
        )

        self.assertEqual(results, {"model": "stale"})

    def test_legacy_tasks_accept_unfingerprinted_results(self) -> None:
        self.write_result("model", resolved=True)

        results = _model_results(self.results, "task", ["model"])

        self.assertEqual(results, {"model": "pass"})

    def test_marks_legacy_result_stale_when_current_fingerprints_are_required(self) -> None:
        self.write_result("model", resolved=True)

        results = _model_results(
            self.results,
            "task",
            ["model"],
            required_task_fingerprints={"definition_sha256": "current"},
        )

        self.assertEqual(results, {"model": "stale"})

    def test_accepts_current_result_schema_and_fingerprints(self) -> None:
        fingerprints = {"definition_sha256": "current"}
        self.write_result(
            "model",
            resolved=True,
            result_schema_version=RESULT_SCHEMA_VERSION,
            task_fingerprints=fingerprints,
        )

        results = _model_results(
            self.results,
            "task",
            ["model"],
            required_task_fingerprints=fingerprints,
        )

        self.assertEqual(results, {"model": "pass"})

    def test_marks_old_validation_schema_stale(self) -> None:
        path = self.results / "validation.json"
        path.write_text(json.dumps({"valid": True}))

        self.assertEqual(
            _validation_status(
                path,
                required_task_fingerprints={"definition_sha256": "current"},
            ),
            "stale",
        )


if __name__ == "__main__":
    unittest.main()
