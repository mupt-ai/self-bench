"""Unit tests for ReviewStore: status management, atomic persistence."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from selfbench.review import ReviewStore, _review_status
from selfbench.task import Task


def _make_task_json(task_dir: Path, *, task_id: str = "test-task") -> Path:
    path = task_dir / "task.json"
    path.write_text(json.dumps({
        "task_id": task_id,
        "repo": "test/repo",
        "base_commit": "abc123",
        "workdir": ".",
        "setup_cmd": "true",
        "test_cmd": "pytest {tests}",
        "fail_to_pass": ["tests/x.py"],
        "pass_to_pass": ["tests/y.py"],
        "test_paths": ["tests"],
        "prompt_source": {"path": "inputs/source.jsonl", "format": "generic"},
    }) + "\n")
    return path


def _make_aux(task_dir: Path) -> None:
    (task_dir / "inputs").mkdir()
    (task_dir / "inputs" / "source.jsonl").write_text('{"role": "user", "content": "fix it"}\n')
    (task_dir / "test.patch").write_text("diff --git a/tests/x.py b/tests/x.py\n")
    (task_dir / "gold.patch").write_text("diff --git a/x.py b/x.py\n")


class ReviewStatusTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        tasks = self.root / "tasks"
        tasks.mkdir()
        self.task_dir = tasks / "test-task"
        self.task_dir.mkdir()
        _make_task_json(self.task_dir)
        _make_aux(self.task_dir)
        self.results = self.root / "results"
        self.results.mkdir()
        self.store = ReviewStore(tasks, self.results, ["openai__gpt-5.5"])

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_default_review_status_is_unreviewed(self) -> None:
        summaries = self.store.summaries()
        self.assertEqual(summaries["review_counts"], {"unreviewed": 1})
        task = summaries["tasks"][0]
        self.assertEqual(task["review_status"], "unreviewed")

    def test_save_quality_persists_review_status_atomically(self) -> None:
        self.store.save_quality("test-task", {"review_status": "approved"})
        summaries = self.store.summaries()
        self.assertEqual(summaries["review_counts"], {"approved": 1})
        self.assertEqual(summaries["tasks"][0]["review_status"], "approved")
        detail = self.store.detail("test-task")
        self.assertEqual(detail["summary"]["review_status"], "approved")

    def test_save_quality_rejects_invalid_statuses(self) -> None:
        with self.assertRaisesRegex(ValueError, "review_status must be one of"):
            self.store.save_quality("test-task", {"review_status": "bogus"})

    def test_save_quality_atomic_after_corruption(self) -> None:
        """Simulate a partial write: .tmp file left from a crash, then a valid save."""
        tmp = self.task_dir / "task.json.tmp"
        tmp.write_text("corrupted garbage")
        self.store.save_quality("test-task", {"review_status": "in_review"})
        detail = self.store.detail("test-task")
        self.assertEqual(detail["summary"]["review_status"], "in_review")
        # The .tmp placeholder should have been replaced by a clean task.json.
        saved = json.loads((self.task_dir / "task.json").read_text())
        self.assertEqual(saved["quality"]["review_status"], "in_review")

    def test_save_quality_persists_notes_and_warnings_and_status_together(self) -> None:
        self.store.save_quality("test-task", {
            "review_notes": "Looks good",
            "reviewed_warnings": ["warn1"],
            "review_status": "changes_requested",
        })
        detail = self.store.detail("test-task")
        self.assertEqual(detail["summary"]["quality"]["review_notes"], "Looks good")
        self.assertEqual(detail["summary"]["quality"]["reviewed_warnings"], ["warn1"])
        self.assertEqual(detail["summary"]["review_status"], "changes_requested")

    def test_review_status_edge_from_legacy_task_without_quality(self) -> None:
        """A task.json without a 'quality' key should default to unreviewed."""
        cfg = json.loads((self.task_dir / "task.json").read_text())
        cfg.pop("quality", None)
        (self.task_dir / "task.json").write_text(json.dumps(cfg) + "\n")
        summaries = self.store.summaries()
        self.assertEqual(summaries["review_counts"], {"unreviewed": 1})
        self.assertEqual(summaries["tasks"][0]["review_status"], "unreviewed")


class ReviewStatusHelperTest(unittest.TestCase):
    def _task(self, quality: dict | None = None) -> Task:
        return Task(
            task_id="test",
            repo="test/repo",
            base_commit="abc",
            workdir=".",
            setup_cmd="true",
            test_cmd="pytest {tests}",
            fail_to_pass=["tests/x.py"],
            pass_to_pass=["tests/y.py"],
            test_paths=["tests"],
            quality=quality or {},
            dir=Path("."),
        )

    def test_unreviewed_for_empty_quality(self) -> None:
        self.assertEqual(_review_status(self._task()), "unreviewed")

    def test_unreviewed_for_missing_status_in_quality(self) -> None:
        self.assertEqual(_review_status(self._task({"review_notes": ""})), "unreviewed")

    def test_unreviewed_for_bogus_status(self) -> None:
        self.assertEqual(_review_status(self._task({"review_status": "bad"})), "unreviewed")

    def test_returns_valid_status(self) -> None:
        for status in ("unreviewed", "in_review", "approved", "changes_requested", "rejected"):
            self.assertEqual(_review_status(self._task({"review_status": status})), status)


if __name__ == "__main__":
    unittest.main()
