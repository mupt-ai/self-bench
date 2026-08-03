from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from selfbench.quality import (
    _brittle_test_signals,
    _gold_coupled_test_identifiers,
    _gold_public_api_test_identifiers,
    _model_results,
    _validation_status,
    audit_task,
)
from selfbench.coupling import save_coupling_review
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


class GoldPublicApiCouplingTest(unittest.TestCase):
    def test_flags_js_prototype_method_only_in_gold(self) -> None:
        flagged = _gold_public_api_test_identifiers(
            "+    route.dispatch(req, res, done)\n",
            "+Route.prototype.dispatch = function dispatch(req, res, done) {\n",
            "Refactor middleware processing so routes run in order.",
        )
        self.assertEqual(flagged, ["dispatch"])

    def test_allows_method_named_in_prompt(self) -> None:
        flagged = _gold_public_api_test_identifiers(
            "+    route.dispatch(req, res, done)\n",
            "+Route.prototype.dispatch = function dispatch(req, res, done) {\n",
            "Expose a dispatch entry point on each route.",
        )
        self.assertEqual(flagged, [])

    def test_allows_reworked_existing_api(self) -> None:
        flagged = _gold_public_api_test_identifiers(
            "+    router.route('/foo')\n",
            "-Router.prototype.route = function(method, path, callbacks) {\n"
            "+Router.prototype.route = function(path) {\n",
            "Refactor the router.",
        )
        self.assertEqual(flagged, [])

    def test_flags_python_public_function_only_in_gold(self) -> None:
        flagged = _gold_public_api_test_identifiers(
            "+    result = client.batch_verify(items)\n",
            "+def batch_verify(items):\n",
            "Verify submitted items efficiently.",
        )
        self.assertEqual(flagged, ["batch_verify"])


class CouplingReviewAuditTest(unittest.TestCase):
    def _audited_task(self, task_dir: Path, review: dict | None):
        (task_dir / "prompt.md").write_text(" ".join(["behavior"] * 100))
        (task_dir / "test.patch").write_text(
            "diff --git a/tests/x.py b/tests/x.py\n+def test_behavior(): pass\n"
        )
        (task_dir / "gold.patch").write_text(
            "diff --git a/src/x.py b/src/x.py\n+def behavior(): pass\n"
        )
        task = Task(
            task_id="review-audit",
            repo="example/repo",
            base_commit="abc123",
            workdir=".",
            setup_cmd="true",
            test_cmd="pytest {tests}",
            fail_to_pass=["tests/x.py::test_behavior"],
            pass_to_pass=["tests/a.py", "tests/b.py", "tests/c.py"],
            test_paths=["tests"],
            trace_source={"path": "inputs/session.jsonl", "format": "generic"},
            dir=task_dir,
        )
        if review is not None:
            save_coupling_review(task, review, provider="p", model="m")
        return audit_task(task, task_dir / "results", [])

    def test_coupled_review_verdict_is_a_blocker(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            audit = self._audited_task(
                Path(raw_dir), {"verdict": "coupled", "findings": [], "summary": ""}
            )
        self.assertTrue(any("coupling review" in b for b in audit.blockers))

    def test_minor_review_verdict_is_a_warning(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            audit = self._audited_task(
                Path(raw_dir), {"verdict": "minor", "findings": [], "summary": ""}
            )
        self.assertFalse(any("coupling review" in b for b in audit.blockers))
        self.assertTrue(any("coupling review" in w for w in audit.warnings))

    def test_clean_review_verdict_adds_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            audit = self._audited_task(
                Path(raw_dir), {"verdict": "clean", "findings": [], "summary": ""}
            )
        self.assertFalse(any("coupling review" in b for b in audit.blockers))
        self.assertFalse(any("coupling review" in w for w in audit.warnings))

    def test_absent_review_adds_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            audit = self._audited_task(Path(raw_dir), None)
        self.assertFalse(any("coupling review" in b for b in audit.blockers))
        self.assertFalse(any("coupling review" in w for w in audit.warnings))

    def test_stale_review_is_a_warning(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            task_dir = Path(raw_dir)
            audit = self._audited_task(
                task_dir, {"verdict": "clean", "findings": [], "summary": ""}
            )
            self.assertFalse(any("stale" in w for w in audit.warnings))
            data = json.loads((task_dir / "coupling_review.json").read_text())
            data["task_fingerprints"]["gold_patch"] = "different"
            (task_dir / "coupling_review.json").write_text(json.dumps(data))
            task = Task(
                task_id="review-audit",
                repo="example/repo",
                base_commit="abc123",
                workdir=".",
                setup_cmd="true",
                test_cmd="pytest {tests}",
                fail_to_pass=["tests/x.py::test_behavior"],
                pass_to_pass=["tests/a.py", "tests/b.py", "tests/c.py"],
                test_paths=["tests"],
                trace_source={"path": "inputs/session.jsonl", "format": "generic"},
                dir=task_dir,
            )
            audit = audit_task(task, task_dir / "results", [])
        self.assertTrue(any("coupling review is stale" in w for w in audit.warnings))


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

    def _task_without_sources(self, task_dir: Path, quality: dict) -> Task:
        (task_dir / "prompt.md").write_text(" ".join(["behavior"] * 100))
        (task_dir / "test.patch").write_text(
            "diff --git a/tests/x.py b/tests/x.py\n+def test_behavior(): pass\n"
        )
        (task_dir / "gold.patch").write_text(
            "diff --git a/src/x.py b/src/x.py\n+def behavior(): pass\n"
        )
        return Task(
            task_id="external-prov",
            repo="example/repo",
            base_commit="abc123",
            workdir=".",
            setup_cmd="true",
            test_cmd="pytest {tests}",
            fail_to_pass=["tests/x.py::test_behavior"],
            pass_to_pass=["tests/a.py", "tests/b.py", "tests/c.py"],
            test_paths=["tests"],
            dir=task_dir,
            quality=quality,
        )

    def test_external_issue_provenance_clears_blocker_but_warns(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            task = self._task_without_sources(
                Path(raw_dir),
                {"provenance": {"kind": "github_issue", "url": "https://github.com/x/y/issues/1"}},
            )
            audit = audit_task(task, Path(raw_dir) / "results", [])

        self.assertFalse(
            any("authentic request provenance" in blocker for blocker in audit.blockers)
        )
        self.assertTrue(
            any("external reference" in warning for warning in audit.warnings)
        )

    def test_external_provenance_accepts_list_of_entries(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            task = self._task_without_sources(
                Path(raw_dir),
                {
                    "provenance": [
                        {"kind": "github_issue", "url": "https://github.com/x/y/issues/1"},
                        {"kind": "github_issue", "url": "https://github.com/x/y/issues/2"},
                    ]
                },
            )
            audit = audit_task(task, Path(raw_dir) / "results", [])

        self.assertFalse(
            any("authentic request provenance" in blocker for blocker in audit.blockers)
        )

    def test_malformed_external_provenance_still_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            task = self._task_without_sources(
                Path(raw_dir),
                {"provenance": {"kind": "github_issue"}},
            )
            audit = audit_task(task, Path(raw_dir) / "results", [])

        self.assertTrue(
            any("authentic request provenance" in blocker for blocker in audit.blockers)
        )


class DependencyManifestCouplingTest(unittest.TestCase):
    def _audit_with_gold(self, task_dir: Path, gold_patch: str):
        (task_dir / "prompt.md").write_text(" ".join(["behavior"] * 100))
        (task_dir / "test.patch").write_text(
            "diff --git a/tests/x.py b/tests/x.py\n+def test_behavior(): pass\n"
        )
        (task_dir / "gold.patch").write_text(gold_patch)
        task = Task(
            task_id="dep-manifest",
            repo="example/repo",
            base_commit="abc123",
            workdir=".",
            setup_cmd="true",
            test_cmd="pytest {tests}",
            fail_to_pass=["tests/x.py::test_behavior"],
            pass_to_pass=["tests/a.py", "tests/b.py", "tests/c.py"],
            test_paths=["tests"],
            trace_source={"path": "inputs/session.jsonl", "format": "generic"},
            dir=task_dir,
        )
        return audit_task(task, task_dir / "results", [])

    def test_warns_when_gold_patch_touches_dependency_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            audit = self._audit_with_gold(
                Path(raw_dir),
                "diff --git a/package.json b/package.json\n+  \"dep\": \"^2.0.0\"\n"
                "diff --git a/lib/x.js b/lib/x.js\n+module.exports = 1\n",
            )

        self.assertTrue(
            any("dependency manifest" in warning for warning in audit.warnings)
        )

    def test_no_manifest_warning_for_code_only_gold_patch(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            audit = self._audit_with_gold(
                Path(raw_dir),
                "diff --git a/lib/x.js b/lib/x.js\n+module.exports = 1\n",
            )

        self.assertFalse(
            any("dependency manifest" in warning for warning in audit.warnings)
        )


class AuditModelIndependenceTest(unittest.TestCase):
    def test_clean_audit_does_not_require_or_depend_on_model_runs(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            root = Path(raw_dir)
            task_dir = root / "task"
            task_dir.mkdir()
            (task_dir / "prompt.md").write_text(" ".join(["requirement"] * 100))
            (task_dir / "test.patch").write_text(
                "diff --git a/tests/x.py b/tests/x.py\n+def test_expected(): pass\n"
            )
            (task_dir / "gold.patch").write_text(
                "diff --git a/src/x.py b/src/x.py\n+implemented = True\n"
            )
            task = Task(
                task_id="task",
                repo="example/repo",
                base_commit="abc123",
                workdir=".",
                setup_cmd="true",
                test_cmd="pytest {tests}",
                fail_to_pass=["tests/x.py::test_expected"],
                pass_to_pass=["tests/a.py", "tests/b.py", "tests/c.py"],
                test_paths=["tests/x.py"],
                trace_source={"path": "inputs/session.jsonl", "format": "generic"},
                dir=task_dir,
            )
            validation = root / "results" / "task" / "validation" / "result.json"
            validation.parent.mkdir(parents=True)
            validation.write_text(json.dumps({
                "valid": True,
                "result_schema_version": RESULT_SCHEMA_VERSION,
                "task_fingerprints": task.evaluation_fingerprints,
            }))

            without_models = audit_task(task, root / "results", [])
            self.assertEqual(without_models.verdict, "accepted")
            self.assertEqual(without_models.solver_signal, "not_requested")
            self.assertEqual(without_models.model_results, {})

            for slug in ("model-a", "model-b"):
                result = root / "results" / "task" / slug / "result.json"
                result.parent.mkdir(parents=True)
                result.write_text(json.dumps({
                    "resolved": True,
                    "result_schema_version": RESULT_SCHEMA_VERSION,
                    "task_fingerprints": task.evaluation_fingerprints,
                }))
            with_models = audit_task(task, root / "results", ["model-a", "model-b"])
            self.assertEqual(with_models.verdict, "accepted")
            self.assertEqual(with_models.solver_signal, "all_solved")


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

    def test_infrastructure_failure_is_not_reported_as_invalid(self) -> None:
        path = self.results / "validation.json"
        path.write_text(json.dumps({
            "valid": False,
            "infrastructure_errors": {"oracle": "RemoteError: Image build failed"},
        }))
        self.assertEqual(_validation_status(path), "infra_error")

    def test_genuine_failure_still_reports_invalid(self) -> None:
        path = self.results / "validation.json"
        path.write_text(json.dumps({"valid": False}))
        self.assertEqual(_validation_status(path), "invalid")


if __name__ == "__main__":
    unittest.main()
