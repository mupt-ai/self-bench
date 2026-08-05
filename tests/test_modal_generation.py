"""Tests for standalone Modal generation manifests and artifacts."""

from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from selfbench.modal_generation import (
    GenerationManifest,
    ManifestError,
    build_worker_request,
    merge_worker_artifacts,
    normalize_candidate,
    verify_worker_artifacts,
    write_worker_artifact_manifest,
)
from selfbench.modal_parent import _validate_parent_manifest, _verify_candidate_commits
from selfbench.modal_worker import (
    CandidateRejected,
    ProvenanceIntegrityError,
    _execute_setup_smoke,
    _verify_provenance,
)
from selfbench.task import Task

SOURCE_COMMIT = "a" * 40
REPO_URL = "https://github.com/example/project.git"


def manifest_data(*, workers: list[dict[str, object]] | None = None) -> dict[str, object]:
    return {
        "schema_version": 1,
        "run_id": "example-run",
        "source": {"repo_url": REPO_URL, "commit": SOURCE_COMMIT},
        "agent": {
            "provider": "openai",
            "model": "gpt-5.6-sol",
            "thinking": "xhigh",
            "profile": "hard",
        },
        "workers": workers
        or [
            {
                "worker_id": "shard-00",
                "candidates": ["https://github.com/example/project/pull/101"],
                "target_count": 1,
            }
        ],
    }


def write_task(tasks_root: Path, task_id: str, pull_number: int) -> Path:
    task_dir = tasks_root / task_id
    task_dir.mkdir(parents=True)
    (task_dir / "task.json").write_text(
        json.dumps(
            {
                "task_id": task_id,
                "repo": "example/project",
                "source_pr": pull_number,
            }
        )
    )
    (task_dir / "gold.patch").write_text(f"gold for {task_id}\n")
    return task_dir


def complete_worker(
    run_root: Path,
    manifest: GenerationManifest,
    worker_index: int,
    *,
    task_id: str,
    pull_number: int,
) -> Path:
    worker = manifest.workers[worker_index]
    worker_root = run_root / "workers" / worker.worker_id
    tasks_root = worker_root / "tasks"
    write_task(tasks_root, task_id, pull_number)
    write_worker_artifact_manifest(
        worker_root,
        tasks_root,
        manifest,
        worker,
        build_commit="b" * 40,
    )
    (worker_root / "_SUCCESS").write_text(manifest.worker_fingerprint(worker) + "\n")
    return worker_root


class ManifestTest(unittest.TestCase):
    def test_parses_explicit_shards_and_has_stable_fingerprint(self) -> None:
        first = GenerationManifest.from_dict(manifest_data())
        second = GenerationManifest.from_dict(first.as_dict())

        self.assertEqual(first, second)
        self.assertEqual(first.fingerprint, second.fingerprint)
        self.assertEqual(first.workers[0].target_count, 1)

    def test_requires_a_full_pinned_source_commit(self) -> None:
        data = manifest_data()
        data["source"] = {"repo_url": REPO_URL, "commit": "main"}

        with self.assertRaisesRegex(ManifestError, "full 40-character commit SHA"):
            GenerationManifest.from_dict(data)

    def test_rejects_duplicate_candidates_across_workers(self) -> None:
        candidate = "https://github.com/example/project/pull/101"
        data = manifest_data(
            workers=[
                {"worker_id": "one", "candidates": [candidate]},
                {"worker_id": "two", "candidates": [candidate + "/"]},
            ]
        )

        with self.assertRaisesRegex(ManifestError, "disjoint"):
            GenerationManifest.from_dict(data)

    def test_target_count_cannot_exceed_candidate_count(self) -> None:
        data = manifest_data()
        workers = data["workers"]
        assert isinstance(workers, list)
        workers[0]["target_count"] = 2

        with self.assertRaisesRegex(ManifestError, "cannot exceed"):
            GenerationManifest.from_dict(data)

    def test_candidate_normalization_matches_url_and_source_pr(self) -> None:
        url_key = normalize_candidate("https://github.com/example/project/pull/101/")
        number_key = normalize_candidate("101", repo_url=REPO_URL)

        self.assertEqual(url_key, number_key)

    def test_worker_request_forbids_discovery_and_remote_validation(self) -> None:
        manifest = GenerationManifest.from_dict(manifest_data())
        request = build_worker_request(manifest, manifest.workers[0])

        self.assertIn("Use only the assigned", request)
        self.assertIn("Do not discover", request)
        self.assertIn("Do not run Harbor", request)
        self.assertIn("centralized validation", request)
        self.assertIn("repository-native setup command", request)
        self.assertIn("frozen lockfile", request)

    def test_parent_manifest_requires_pinned_candidate_metadata(self) -> None:
        data = manifest_data()
        workers = data["workers"]
        assert isinstance(workers, list)
        workers[0].update(
            {
                "source_pr": 101,
                "base_commit": "b" * 40,
                "completed_commit": "c" * 40,
                "provenance": {
                    "kind": "url",
                    "url": "https://github.com/example/project/issues/99",
                },
                "request": "Behavioral parser change with separable tests.",
            }
        )
        manifest = GenerationManifest.from_dict(data)

        _validate_parent_manifest(
            manifest,
            run_id="example-run",
            target_count=1,
            expected_candidates=1,
            repo_url=REPO_URL,
            source_commit=SOURCE_COMMIT,
            profile="hard",
            provider="openai",
            model="gpt-5.6-sol",
            thinking="xhigh",
        )

    def test_parent_manifest_rejects_missing_candidate_commits(self) -> None:
        data = manifest_data()
        workers = data["workers"]
        assert isinstance(workers, list)
        workers[0]["source_pr"] = 101
        manifest = GenerationManifest.from_dict(data)

        with self.assertRaisesRegex(ManifestError, "missing pinned commits"):
            _validate_parent_manifest(
                manifest,
                run_id="example-run",
                target_count=1,
                expected_candidates=1,
                repo_url=REPO_URL,
                source_commit=SOURCE_COMMIT,
                profile="hard",
                provider="openai",
                model="gpt-5.6-sol",
                thinking="xhigh",
            )


class ArtifactTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_completed_worker_verifies_and_merges_idempotently(self) -> None:
        manifest = GenerationManifest.from_dict(manifest_data())
        run_root = self.root / "downloaded-run"
        worker_root = complete_worker(
            run_root,
            manifest,
            0,
            task_id="task-101",
            pull_number=101,
        )

        verified = verify_worker_artifacts(worker_root, manifest, manifest.workers[0])
        self.assertEqual([task.task_id for task in verified], ["task-101"])

        output = self.root / "tasks"
        first = merge_worker_artifacts(manifest, run_root, output)
        second = merge_worker_artifacts(manifest, run_root, output)
        self.assertEqual(first, second)
        self.assertTrue((output / "task-101" / "task.json").is_file())
        self.assertTrue((output / ".selfbench-generation.json").is_file())

    def test_tampered_task_file_is_rejected(self) -> None:
        manifest = GenerationManifest.from_dict(manifest_data())
        run_root = self.root / "downloaded-run"
        worker_root = complete_worker(
            run_root,
            manifest,
            0,
            task_id="task-101",
            pull_number=101,
        )
        (worker_root / "tasks" / "task-101" / "gold.patch").write_text("tampered\n")

        with self.assertRaisesRegex(ManifestError, "hashes do not match"):
            verify_worker_artifacts(worker_root, manifest, manifest.workers[0])

    def test_unassigned_task_provenance_is_rejected_before_completion(self) -> None:
        manifest = GenerationManifest.from_dict(manifest_data())
        worker = manifest.workers[0]
        worker_root = self.root / "worker"
        tasks_root = worker_root / "tasks"
        write_task(tasks_root, "task-999", 999)

        with self.assertRaisesRegex(ManifestError, "is not assigned"):
            write_worker_artifact_manifest(
                worker_root,
                tasks_root,
                manifest,
                worker,
                build_commit="b" * 40,
            )

    def test_duplicate_task_id_across_workers_is_rejected(self) -> None:
        manifest = GenerationManifest.from_dict(
            manifest_data(
                workers=[
                    {
                        "worker_id": "one",
                        "candidates": ["https://github.com/example/project/pull/101"],
                    },
                    {
                        "worker_id": "two",
                        "candidates": ["https://github.com/example/project/pull/102"],
                    },
                ]
            )
        )
        run_root = self.root / "downloaded-run"
        complete_worker(run_root, manifest, 0, task_id="same-task", pull_number=101)
        complete_worker(run_root, manifest, 1, task_id="same-task", pull_number=102)

        with self.assertRaisesRegex(ManifestError, "duplicate generated task_id"):
            merge_worker_artifacts(manifest, run_root, self.root / "tasks")

    def test_existing_different_task_is_not_overwritten(self) -> None:
        manifest = GenerationManifest.from_dict(manifest_data())
        run_root = self.root / "downloaded-run"
        complete_worker(run_root, manifest, 0, task_id="task-101", pull_number=101)
        output = self.root / "tasks"
        write_task(output, "task-101", 101)
        (output / "task-101" / "gold.patch").write_text("local content\n")

        with self.assertRaisesRegex(ManifestError, "existing task conflicts"):
            merge_worker_artifacts(manifest, run_root, output)

    def test_reserve_worker_is_not_required_after_target_is_met(self) -> None:
        data = manifest_data(
            workers=[
                {
                    "worker_id": "active",
                    "candidates": ["https://github.com/example/project/pull/101"],
                },
                {
                    "worker_id": "reserve",
                    "candidates": ["https://github.com/example/project/pull/102"],
                },
            ]
        )
        data["target_count"] = 1
        manifest = GenerationManifest.from_dict(data)
        run_root = self.root / "downloaded-run"
        complete_worker(run_root, manifest, 0, task_id="task-101", pull_number=101)

        report = merge_worker_artifacts(manifest, run_root, self.root / "tasks")

        self.assertEqual([task["task_id"] for task in report["tasks"]], ["task-101"])

    def test_merge_fails_when_reserves_do_not_fill_target(self) -> None:
        manifest = GenerationManifest.from_dict(manifest_data())

        with self.assertRaisesRegex(ManifestError, "0 completed tasks; expected exactly 1"):
            merge_worker_artifacts(manifest, self.root / "downloaded-run", self.root / "tasks")

    def test_staged_provenance_must_match_its_hash(self) -> None:
        provenance = self.root / "inputs" / "session.jsonl"
        provenance.parent.mkdir()
        provenance.write_text("original\n")
        checksum = hashlib.sha256(provenance.read_bytes()).hexdigest()
        data = manifest_data()
        workers = data["workers"]
        assert isinstance(workers, list)
        workers[0]["provenance"] = {
            "kind": "file",
            "path": str(provenance),
            "format": "auto",
            "message_index": 0,
            "sha256": checksum,
        }
        worker = GenerationManifest.from_dict(data).workers[0]

        _verify_provenance(worker, self.root)
        provenance.write_text("changed\n")
        with self.assertRaisesRegex(ProvenanceIntegrityError, "does not match"):
            _verify_provenance(worker, self.root)


class CandidateCommitTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary.name)
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(
            ["git", "-C", str(self.repo), "config", "user.email", "test@example.com"],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(self.repo), "config", "user.name", "Test"],
            check=True,
        )
        (self.repo / "file.txt").write_text("base\n")
        subprocess.run(["git", "-C", str(self.repo), "add", "file.txt"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-qm", "base"], check=True)
        self.base = self._git("rev-parse", "HEAD")
        (self.repo / "file.txt").write_text("complete\n")
        subprocess.run(["git", "-C", str(self.repo), "commit", "-qam", "complete"], check=True)
        self.completed = self._git("rev-parse", "HEAD")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _git(self, *args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(self.repo), *args],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    def _manifest(self, base: str, completed: str) -> GenerationManifest:
        data = manifest_data()
        workers = data["workers"]
        assert isinstance(workers, list)
        workers[0].update(
            {
                "source_pr": 101,
                "base_commit": base,
                "completed_commit": completed,
                "provenance": {
                    "kind": "url",
                    "url": "https://github.com/example/project/issues/99",
                },
            }
        )
        return GenerationManifest.from_dict(data)

    def test_accepts_ancestor_base_commit(self) -> None:
        _verify_candidate_commits(self.repo, self._manifest(self.base, self.completed))

    def test_rejects_non_ancestor_base_commit(self) -> None:
        with self.assertRaisesRegex(ManifestError, "is not an ancestor"):
            _verify_candidate_commits(self.repo, self._manifest(self.completed, self.base))

    def test_setup_smoke_runs_in_fresh_base_worktree(self) -> None:
        task = Task(
            task_id="setup-smoke",
            repo="example/project",
            base_commit=self.base,
            workdir=".",
            setup_cmd="test \"$(cat file.txt)\" = base",
            test_cmd="true {tests}",
            fail_to_pass=["test"],
            pass_to_pass=[],
        )
        stdout_path = self.repo / "setup-stdout.log"
        stderr_path = self.repo / "setup-stderr.log"
        with tempfile.TemporaryDirectory() as setup_root:
            checkout = Path(setup_root) / "checkout"
            with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
                duration = _execute_setup_smoke(
                    task,
                    None,
                    self.repo,
                    checkout,
                    stdout=stdout,
                    stderr=stderr,
                )

            self.assertGreaterEqual(duration, 0)
            self.assertFalse(checkout.exists())

    def test_setup_smoke_rejects_failed_setup(self) -> None:
        task = Task(
            task_id="setup-fail",
            repo="example/project",
            base_commit=self.base,
            workdir=".",
            setup_cmd="exit 23",
            test_cmd="true {tests}",
            fail_to_pass=["test"],
            pass_to_pass=[],
        )
        with tempfile.TemporaryDirectory() as setup_root:
            checkout = Path(setup_root) / "checkout"
            with (self.repo / "fail-stdout.log").open("wb") as stdout, (
                self.repo / "fail-stderr.log"
            ).open("wb") as stderr, self.assertRaisesRegex(
                CandidateRejected, "setup command exited 23"
            ):
                _execute_setup_smoke(
                    task,
                    None,
                    self.repo,
                    checkout,
                    stdout=stdout,
                    stderr=stderr,
                )

            self.assertFalse(checkout.exists())


if __name__ == "__main__":
    unittest.main()
