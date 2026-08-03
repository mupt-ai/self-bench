"""Tests for the independent coupling review pass."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from selfbench.coupling import (
    _parse_review,
    build_coupling_request,
    load_coupling_review,
    review_coupling,
    save_coupling_review,
)
from selfbench.task import Task


def _make_task(task_dir: Path) -> Task:
    (task_dir / "prompt.md").write_text("Add retry handling to the client request path.")
    (task_dir / "test.patch").write_text(
        "diff --git a/tests/x.py b/tests/x.py\n+def test_retries(): pass\n"
    )
    (task_dir / "gold.patch").write_text(
        "diff --git a/src/x.py b/src/x.py\n+def retry(): pass\n"
    )
    return Task(
        task_id="coupling-task",
        repo="example/repo",
        base_commit="abc123",
        workdir=".",
        setup_cmd="true",
        test_cmd="pytest {tests}",
        fail_to_pass=["tests/x.py::test_retries"],
        pass_to_pass=["tests/a.py"],
        test_paths=["tests"],
        dir=task_dir,
    )


class BuildCouplingRequestTest(unittest.TestCase):
    def test_request_contains_prompt_and_both_patches(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            task = _make_task(Path(raw_dir))
            request = build_coupling_request(task)
        self.assertIn("Add retry handling", request)
        self.assertIn("HELD-OUT TEST PATCH", request)
        self.assertIn("GOLD PATCH", request)
        self.assertIn("test_retries", request)
        self.assertIn('"verdict"', request)

    def test_request_names_graded_selectors(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            task = _make_task(Path(raw_dir))
            request = build_coupling_request(task)
        self.assertIn("tests/x.py::test_retries", request)
        self.assertIn("fail-to-pass", request)

    def test_request_never_mentions_source_pr_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            task = _make_task(Path(raw_dir))
            request = build_coupling_request(task)
        self.assertNotIn("source_pr", request)
        self.assertNotIn(task.base_commit, request)


class ParseReviewTest(unittest.TestCase):
    def test_parses_bare_json(self) -> None:
        review = _parse_review('{"verdict": "clean", "findings": [], "summary": "ok"}')
        self.assertEqual(review["verdict"], "clean")

    def test_parses_fenced_json(self) -> None:
        review = _parse_review('```json\n{"verdict": "minor", "findings": []}\n```')
        self.assertEqual(review["verdict"], "minor")

    def test_parses_json_with_surrounding_prose(self) -> None:
        review = _parse_review('Here is my audit:\n{"verdict": "coupled", "findings": []}\nDone.')
        self.assertEqual(review["verdict"], "coupled")

    def test_rejects_unknown_verdict(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown verdict"):
            _parse_review('{"verdict": "fine"}')

    def test_rejects_non_json(self) -> None:
        with self.assertRaisesRegex(ValueError, "no JSON object"):
            _parse_review("all clear, looks good")

    def test_defaults_missing_findings_to_empty_list(self) -> None:
        review = _parse_review('{"verdict": "clean"}')
        self.assertEqual(review["findings"], [])


class ReviewCouplingTest(unittest.TestCase):
    @patch("selfbench.coupling.subprocess.run")
    def test_invokes_isolated_pi_and_parses_result(self, run_mock) -> None:
        run_mock.return_value.returncode = 0
        run_mock.return_value.stdout = '{"verdict": "clean", "findings": [], "summary": "ok"}'
        with tempfile.TemporaryDirectory() as raw_dir:
            task = _make_task(Path(raw_dir))
            review = review_coupling(
                task, provider="openai", model="gpt-5.6-sol", pi_executable="/custom/pi"
            )
        self.assertEqual(review["verdict"], "clean")
        command = run_mock.call_args.args[0]
        self.assertEqual(command[0], "/custom/pi")
        for flag in ("--no-session", "--no-tools", "--no-extensions", "--no-skills",
                     "--no-prompt-templates", "--no-context-files"):
            self.assertIn(flag, command)

    @patch("selfbench.coupling.subprocess.run")
    def test_raises_on_reviewer_failure(self, run_mock) -> None:
        run_mock.return_value.returncode = 2
        run_mock.return_value.stdout = ""
        run_mock.return_value.stderr = "boom"
        with tempfile.TemporaryDirectory() as raw_dir:
            task = _make_task(Path(raw_dir))
            with self.assertRaisesRegex(RuntimeError, "exited 2"):
                review_coupling(task, provider="openai", model="m", pi_executable="/pi")


class SaveAndLoadReviewTest(unittest.TestCase):
    def test_round_trip_and_staleness(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            task_dir = Path(raw_dir)
            task = _make_task(task_dir)
            path = save_coupling_review(
                task,
                {"verdict": "clean", "findings": [], "summary": "ok"},
                provider="openai",
                model="gpt-5.6-sol",
            )
            self.assertEqual(path, task_dir / "coupling_review.json")

            loaded = load_coupling_review(task)
            assert loaded is not None
            self.assertEqual(loaded["verdict"], "clean")
            self.assertNotIn("stale", loaded)

            (task_dir / "gold.patch").write_text(
                "diff --git a/src/y.py b/src/y.py\n+def other(): pass\n"
            )
            edited = _make_task_reload(task_dir)
            stale = load_coupling_review(edited)
            assert stale is not None
            self.assertTrue(stale.get("stale"))

    def test_missing_review_returns_none(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            task = _make_task(Path(raw_dir))
            self.assertIsNone(load_coupling_review(task))

    def test_unreadable_review_reported(self) -> None:
        with tempfile.TemporaryDirectory() as raw_dir:
            task_dir = Path(raw_dir)
            task = _make_task(task_dir)
            (task_dir / "coupling_review.json").write_text("{not json")
            loaded = load_coupling_review(task)
            assert loaded is not None
            self.assertEqual(loaded["verdict"], "unreadable")


def _make_task_reload(task_dir: Path) -> Task:
    return Task(
        task_id="coupling-task",
        repo="example/repo",
        base_commit="abc123",
        workdir=".",
        setup_cmd="true",
        test_cmd="pytest {tests}",
        fail_to_pass=["tests/x.py::test_retries"],
        pass_to_pass=["tests/a.py"],
        test_paths=["tests"],
        dir=task_dir,
    )


if __name__ == "__main__":
    unittest.main()
