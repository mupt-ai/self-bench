"""Task definition: one merged PR turned into a benchmark task."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

from .agent_input import SUPPORTED_FORMATS, extract_prompt, extract_trace


@dataclass
class Task:
    task_id: str
    repo: str  # e.g. "example/project", informational
    base_commit: str  # sha the PR was merged onto (parent of merge commit)
    workdir: str  # repo-relative dir where setup/test commands run, "." for root
    setup_cmd: str  # e.g. "uv sync --group dev --frozen"
    test_cmd: str  # must contain "{tests}", e.g. "uv run pytest -q {tests}"
    fail_to_pass: list[str]  # test ids that fail at base and pass with the gold patch
    pass_to_pass: list[str]  # test ids that pass before and must still pass
    test_paths: list[str] = field(default_factory=list)  # repo-relative paths owned by test.patch
    source_pr: int | None = None
    source_url: str | None = None
    prompt_source: dict[str, object] | None = None
    trace_source: dict[str, object] | None = None
    prompt_generation: dict[str, object] | None = None
    quality: dict[str, object] = field(default_factory=dict)
    timeout_setup: int = 900
    timeout_agent: int = 2400
    timeout_tests: int = 900

    dir: Path = field(default=None, repr=False)  # type: ignore[assignment]

    @property
    def prompt(self) -> str:
        if self.prompt_source is not None:
            source_path, source_format, message_index = self._prompt_source_values()
            return extract_prompt(source_path, source_format=source_format, message_index=message_index)
        return (self.dir / "prompt.md").read_text()

    @property
    def prompt_sha256(self) -> str:
        return hashlib.sha256(self.prompt.encode()).hexdigest()

    @property
    def prompt_origin(self) -> dict[str, object]:
        if self.prompt_source is None:
            return {"kind": "prompt.md", "path": "prompt.md"}
        source_path, source_format, message_index = self._prompt_source_values()
        return {
            "kind": "agent_json",
            "path": str(source_path.relative_to(self.dir)),
            "format": source_format,
            "message_index": message_index,
        }

    @property
    def source_trace(self) -> dict[str, object] | None:
        source = self.trace_source or self.prompt_source
        if source is None:
            return None
        if not isinstance(source, dict):
            raise ValueError("trace_source must be an object")
        source_path, source_format = self._trace_source_values(source)
        trace = extract_trace(source_path, source_format=source_format)
        return {
            "origin": {
                "path": str(source_path.relative_to(self.dir)),
                "format": trace["format"],
            },
            "messages": trace["messages"],
        }

    @property
    def test_patch(self) -> str:
        return (self.dir / "test.patch").read_text()

    @property
    def gold_patch(self) -> str:
        return (self.dir / "gold.patch").read_text()

    def _prompt_source_values(self) -> tuple[Path, str, int]:
        source = self.prompt_source
        if not isinstance(source, dict):
            raise ValueError("prompt_source must be an object")
        source_path, source_format = self._trace_source_values(source, field_name="prompt_source")

        message_index = source.get("message_index", 0)
        if not isinstance(message_index, int) or isinstance(message_index, bool):
            raise ValueError("prompt_source.message_index must be an integer")
        return source_path, source_format, message_index

    def _trace_source_values(
        self,
        source: dict[str, object],
        *,
        field_name: str = "trace_source",
    ) -> tuple[Path, str]:
        raw_path = source.get("path")
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise ValueError(f"{field_name}.path must be a non-empty task-relative path")
        relative_path = Path(raw_path)
        if relative_path.is_absolute() or ".." in relative_path.parts:
            raise ValueError(f"{field_name}.path must stay inside the task directory")

        source_format = source.get("format", "auto")
        if not isinstance(source_format, str) or source_format not in SUPPORTED_FORMATS:
            supported = ", ".join(sorted(SUPPORTED_FORMATS))
            raise ValueError(f"{field_name}.format must be one of {supported}")
        return self.dir / relative_path, source_format


def load_task(task_dir: str | Path) -> Task:
    task_dir = Path(task_dir).resolve()
    cfg = json.loads((task_dir / "task.json").read_text())
    task = Task(dir=task_dir, **cfg)

    problems = []
    if "{tests}" not in task.test_cmd:
        problems.append('test_cmd must contain the "{tests}" placeholder')
    if not task.fail_to_pass:
        problems.append("fail_to_pass must not be empty")
    if not task.base_commit:
        problems.append("base_commit is required")
    has_prompt_file = (task_dir / "prompt.md").is_file()
    if has_prompt_file == (task.prompt_source is not None):
        problems.append("provide exactly one of prompt.md or task.json prompt_source")
    if task.prompt_source is not None:
        try:
            task.prompt
        except ValueError as exc:
            problems.append(str(exc))
    if task.trace_source is not None:
        try:
            if not isinstance(task.trace_source, dict):
                raise ValueError("trace_source must be an object")
            trace_path, _ = task._trace_source_values(task.trace_source)
            if not trace_path.is_file():
                problems.append(f"trace_source does not exist: {trace_path}")
        except ValueError as exc:
            problems.append(str(exc))
    if task.prompt_generation is not None:
        if not isinstance(task.prompt_generation, dict):
            problems.append("prompt_generation must be an object")
        elif task.prompt_generation.get("prompt_sha256") != task.prompt_sha256:
            problems.append("prompt.md does not match prompt_generation.prompt_sha256")
    for name in ("test.patch", "gold.patch"):
        if not (task_dir / name).is_file():
            problems.append(f"missing {name}")
    if not task.test_paths:
        problems.append("test_paths must list the files/dirs the test patch touches")
    if problems:
        raise ValueError(f"invalid task {task_dir}: " + "; ".join(problems))
    return task
