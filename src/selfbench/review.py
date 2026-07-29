"""Local review API and static server for benchmark task curation."""

from __future__ import annotations

import argparse
import json
import mimetypes
import shutil
import subprocess
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from .quality import AuditResult, audit_task
from .result_schema import RESULT_SCHEMA_VERSION
from .task import Task, load_task


_REVIEW_BUILD_LOCK = threading.Lock()
_REVIEW_STATUSES = {"unreviewed", "in_review", "approved", "changes_requested", "rejected"}


class ReviewStore:
    def __init__(self, tasks_root: Path, results_root: Path, model_slugs: list[str]):
        self.tasks_root = tasks_root.resolve()
        self.results_root = results_root.resolve()
        self.model_slugs = model_slugs

    def task_dirs(self) -> list[Path]:
        if (self.tasks_root / "task.json").is_file():
            return [self.tasks_root]
        if not self.tasks_root.is_dir():
            return []
        return sorted(path for path in self.tasks_root.iterdir() if (path / "task.json").is_file())

    def load_tasks(self) -> list[Task]:
        return [load_task(task_dir) for task_dir in self.task_dirs()]

    def get_task(self, task_id: str) -> Task:
        for task_dir in self.task_dirs():
            task = load_task(task_dir)
            if task.task_id == task_id:
                return task
        raise KeyError(task_id)

    def summaries(self) -> dict[str, object]:
        tasks = self.load_tasks()
        audits = [audit_task(task, self.results_root, self.model_slugs) for task in tasks]
        counts: dict[str, int] = {}
        review_counts: dict[str, int] = {}
        summaries = []
        for task, audit in zip(tasks, audits, strict=True):
            counts[audit.verdict] = counts.get(audit.verdict, 0) + 1
            review_status = _review_status(task)
            review_counts[review_status] = review_counts.get(review_status, 0) + 1
            summaries.append(self._summary(task, audit))
        return {
            "models": self.model_slugs,
            "counts": counts,
            "review_counts": review_counts,
            "tasks": summaries,
        }

    def detail(self, task_id: str) -> dict[str, object]:
        task = self.get_task(task_id)
        audit = audit_task(task, self.results_root, self.model_slugs)
        validation = _read_json(self.results_root / task.task_id / "validation" / "result.json")
        task_json = _read_json(task.dir / "task.json") or {}
        return {
            "summary": self._summary(task, audit),
            "task_json_text": json.dumps(task_json, indent=2),
            "prompt": task.prompt,
            "prompt_origin": task.prompt_origin,
            "source_trace": task.source_trace,
            "validation_result": validation,
            "validation_text": json.dumps(validation, indent=2) if validation is not None else "",
            "runs": {
                slug: self._run_detail(
                    task.task_id,
                    slug,
                    current_prompt_sha256=task.prompt_sha256,
                    enforce_prompt_fingerprint=task.prompt_generation is not None,
                    current_task_fingerprints=task.evaluation_fingerprints,
                )
                for slug in self.model_slugs
            },
        }

    def _summary(self, task: Task, audit: AuditResult) -> dict[str, object]:
        return {
            "task_id": task.task_id,
            "repo": task.repo,
            "workdir": task.workdir,
            "source_pr": task.source_pr,
            "source_url": task.source_url,
            "validation": audit.validation,
            "verdict": audit.verdict,
            "solver_signal": audit.solver_signal,
            "model_results": audit.model_results,
            "blockers": audit.blockers,
            "warnings": audit.warnings,
            "quality": task.quality,
            "review_status": _review_status(task),
            "fail_to_pass_count": len(task.fail_to_pass),
            "pass_to_pass_count": len(task.pass_to_pass),
        }

    def _run_detail(
        self,
        task_id: str,
        slug: str,
        *,
        current_prompt_sha256: str | None = None,
        enforce_prompt_fingerprint: bool = False,
        current_task_fingerprints: dict[str, str] | None = None,
    ) -> dict[str, object]:
        run_dir = self.results_root / task_id / slug
        result = _read_json(run_dir / "result.json")
        agent_patch = _read_text(run_dir / "agent.patch")
        if agent_patch is None and isinstance(result, dict):
            value = result.get("agent_patch")
            agent_patch = value if isinstance(value, str) else ""
        prompt_status = "untracked"
        stale_reason = None
        if isinstance(result, dict) and current_prompt_sha256 is not None:
            if (
                current_task_fingerprints is not None
                and (
                    result.get("result_schema_version") != RESULT_SCHEMA_VERSION
                    or result.get("task_fingerprints") != current_task_fingerprints
                )
            ):
                prompt_status = "stale"
                stale_reason = "Benchmark inputs or result schema changed. Rerun before interpreting this result."
            elif result.get("prompt_sha256") == current_prompt_sha256:
                prompt_status = "current"
            elif enforce_prompt_fingerprint:
                prompt_status = "stale"
                stale_reason = "The eval prompt changed. Rerun before interpreting this result."
        return {
            "exists": result is not None,
            "prompt_status": prompt_status,
            "stale_reason": stale_reason,
            "result": result,
            "result_text": json.dumps(result, indent=2) if result is not None else "",
            "agent_patch": agent_patch or "",
        }

    def patch_text(self, task_id: str, patch_kind: str, model_slug: str | None = None) -> str:
        task = self.get_task(task_id)
        if patch_kind == "test":
            return task.test_patch
        if patch_kind == "gold":
            return task.gold_patch
        if patch_kind == "agent" and model_slug:
            patch = self._run_detail(task_id, model_slug).get("agent_patch")
            return patch if isinstance(patch, str) else ""
        raise KeyError(f"unknown patch {patch_kind}")

    def save_quality(self, task_id: str, payload: dict[str, object]) -> dict[str, object]:
        task = self.get_task(task_id)
        path = task.dir / "task.json"
        cfg = _read_json(path)
        if not isinstance(cfg, dict):
            raise ValueError(f"cannot read {path}")
        quality = cfg.get("quality")
        if not isinstance(quality, dict):
            quality = {}

        if "review_notes" in payload:
            notes = payload["review_notes"]
            quality["review_notes"] = str(notes) if notes is not None else ""
        if "reviewed_warnings" in payload:
            reviewed = payload["reviewed_warnings"]
            if not isinstance(reviewed, list):
                raise ValueError("reviewed_warnings must be a list")
            quality["reviewed_warnings"] = [str(item) for item in reviewed if str(item)]
        if "review_status" in payload:
            status = str(payload["review_status"] or "unreviewed")
            if status not in _REVIEW_STATUSES:
                raise ValueError(f"review_status must be one of {', '.join(sorted(_REVIEW_STATUSES))}")
            quality["review_status"] = status

        cfg["quality"] = quality
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(cfg, indent=2) + "\n")
        temporary.replace(path)
        return self.detail(task_id)


def serve_review_site(
    *,
    tasks_root: Path,
    results_root: Path,
    model_slugs: list[str],
    host: str,
    port: int,
) -> None:
    review_dist = _ensure_review_build()
    store = ReviewStore(tasks_root, results_root, model_slugs)

    class Handler(ReviewHandler):
        review_store = store
        static_root = review_dist

    server = ThreadingHTTPServer((host, port), Handler)
    actual_host, actual_port = server.server_address
    print(f"review site: http://{actual_host}:{actual_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nreview site stopped", flush=True)
    finally:
        server.server_close()


class ReviewHandler(BaseHTTPRequestHandler):
    review_store: ReviewStore
    static_root: Path

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        if path == "/api/tasks":
            self._send_json(self.review_store.summaries())
            return
        patch_match = _match_patch_path(path)
        if patch_match is not None:
            task_id, patch_kind, model_slug = patch_match
            try:
                self._send_text(
                    self.review_store.patch_text(task_id, patch_kind, model_slug),
                    "text/plain; charset=utf-8",
                )
            except KeyError:
                self._send_error_json(HTTPStatus.NOT_FOUND, "unknown patch")
            return
        if path.startswith("/api/tasks/"):
            task_id = unquote(path.removeprefix("/api/tasks/"))
            try:
                self._send_json(self.review_store.detail(task_id))
            except KeyError:
                self._send_error_json(HTTPStatus.NOT_FOUND, f"unknown task {task_id}")
            return
        self._send_static(path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if path.startswith("/api/tasks/") and path.endswith("/quality"):
            task_id = unquote(path.removeprefix("/api/tasks/").removesuffix("/quality").rstrip("/"))
            try:
                payload = self._read_json_body()
                self._send_json(self.review_store.save_quality(task_id, payload))
            except KeyError:
                self._send_error_json(HTTPStatus.NOT_FOUND, f"unknown task {task_id}")
            except ValueError as exc:
                self._send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
            return
        self._send_error_json(HTTPStatus.NOT_FOUND, "not found")

    def log_message(self, format: str, *args: object) -> None:
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(format, *args)

    def _read_json_body(self) -> dict[str, object]:
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length).decode("utf-8")
        try:
            payload = json.loads(raw or "{}")
        except json.JSONDecodeError as exc:
            raise ValueError("request body must be JSON") from exc
        if not isinstance(payload, dict):
            raise ValueError("request body must be a JSON object")
        return payload

    def _send_static(self, request_path: str) -> None:
        relative = request_path.lstrip("/")
        candidate = (self.static_root / relative).resolve()
        if relative and candidate.is_relative_to(self.static_root) and candidate.is_file():
            self._send_file(candidate, cache=relative.startswith("assets/"))
            return
        self._send_file(self.static_root / "index.html", cache=False)

    def _send_file(self, path: Path, *, cache: bool) -> None:
        body = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix == ".js":
            content_type = "application/javascript"
        self.send_response(HTTPStatus.OK)
        self.send_header("content-type", content_type)
        self.send_header("cache-control", "public, max-age=31536000, immutable" if cache else "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, status: HTTPStatus, message: str) -> None:
        self._send_json({"error": message}, status=status)

    def _send_text(self, value: str, content_type: str) -> None:
        body = value.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def cmd_review(args: argparse.Namespace) -> int:
    serve_review_site(
        tasks_root=Path(args.tasks).resolve(),
        results_root=Path(args.results).resolve(),
        model_slugs=args.models or [],
        host=args.host,
        port=args.port,
    )
    return 0


def _match_patch_path(path: str) -> tuple[str, str, str | None] | None:
    parts = [unquote(part) for part in path.split("/") if part]
    if len(parts) < 5 or parts[:2] != ["api", "tasks"] or parts[3] != "patch":
        return None
    task_id = parts[2]
    patch_kind = parts[4]
    if patch_kind in {"test", "gold"} and len(parts) == 5:
        return task_id, patch_kind, None
    if patch_kind == "agent" and len(parts) == 6:
        return task_id, patch_kind, parts[5]
    return None


def _ensure_review_build() -> Path:
    repo_root = Path(__file__).resolve().parents[2]
    source_root = repo_root / "review"
    dist_root = repo_root / "src" / "selfbench" / "review_dist"
    index = dist_root / "index.html"
    sources = [repo_root / "package.json", repo_root / "bun.lock", *source_root.rglob("*")]
    latest_source = max(path.stat().st_mtime for path in sources if path.is_file())
    if index.is_file() and index.stat().st_mtime >= latest_source:
        return dist_root

    with _REVIEW_BUILD_LOCK:
        if index.is_file() and index.stat().st_mtime >= latest_source:
            return dist_root
        bun = shutil.which("bun")
        if bun is None:
            raise RuntimeError("bun is required to build the review frontend")
        if not (repo_root / "node_modules" / "vite").exists():
            _run_bun([bun, "install", "--frozen-lockfile"], repo_root)
        _run_bun([bun, "run", "build:review"], repo_root)
        if not index.is_file():
            raise RuntimeError("frontend build did not produce src/selfbench/review_dist/index.html")
        return dist_root


def _run_bun(command: list[str], cwd: Path) -> None:
    result = subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        output = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"{' '.join(command)} failed: {output[-3000:]}")


def _review_status(task: Task) -> str:
    status = task.quality.get("review_status")
    return str(status) if status in _REVIEW_STATUSES else "unreviewed"


def _read_json(path: Path) -> object | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return None


def _read_text(path: Path) -> str | None:
    if not path.is_file():
        return None
    return path.read_text(errors="replace")
