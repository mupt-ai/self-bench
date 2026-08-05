"""Task definition: one merged PR turned into a benchmark task."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .agent_input import SUPPORTED_FORMATS, extract_prompt, extract_trace

SUPPORTED_TOOLCHAINS = ("uv", "bun", "go", "node", "python", "rust")
DEFAULT_TOOLCHAINS = ("uv", "bun", "go", "node")
_TOOLCHAIN_DEPENDENCIES = {"python": ("uv",)}


def resolve_toolchains(toolchains: list[str] | None) -> tuple[str, ...]:
    if toolchains is None:
        return DEFAULT_TOOLCHAINS
    if not isinstance(toolchains, list) or not toolchains or any(
        not isinstance(name, str) or not name for name in toolchains
    ):
        raise ValueError("toolchains must be a non-empty list of toolchain names")

    unknown = sorted(set(toolchains) - set(SUPPORTED_TOOLCHAINS))
    if unknown:
        raise ValueError(
            f"unknown toolchain(s): {', '.join(unknown)}; "
            f"available: {', '.join(SUPPORTED_TOOLCHAINS)}"
        )
    if len(toolchains) != len(set(toolchains)):
        raise ValueError("toolchains must not contain duplicates")

    selected = set(toolchains)
    for name in toolchains:
        selected.update(_TOOLCHAIN_DEPENDENCIES.get(name, ()))
    return tuple(name for name in SUPPORTED_TOOLCHAINS if name in selected)


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
    # Environment baseline. The agent container needs egress while Harbor
    # installs the coding agent (node, npm, apt), so this stays public; the
    # agent's own run phase and the verifier are sealed separately below.
    # None preserves the historical default toolchain for existing tasks.
    toolchains: list[str] | None = None
    network_mode: str = "public"
    # Network policy while the coding agent actually works the task. Sealed by
    # default: agents otherwise clone the upstream repository or fetch the
    # source PR diff and copy the reference implementation. Provider API hosts
    # are supplied to Harbor when the eval is run, so the agent can reach its
    # model and nothing else.
    agent_network_mode: str = "allowlist"
    agent_allowed_hosts: list[str] = field(default_factory=list)
    # Setup dependencies are installed while building the verifier image. The
    # test phase is offline by default to prevent solver code from exfiltrating
    # held-out material or making evaluation depend on external services.
    verifier_network_mode: str = "no-network"
    cpus: int = 4
    memory_mb: int = 8192
    storage_mb: int = 20480

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
    def evaluation_fingerprints(self) -> dict[str, str]:
        definition = {
            "task_id": self.task_id,
            "repo": self.repo,
            "base_commit": self.base_commit,
            "workdir": self.workdir,
            "setup_cmd": self.setup_cmd,
            "test_cmd": self.test_cmd,
            "fail_to_pass": self.fail_to_pass,
            "pass_to_pass": self.pass_to_pass,
            "test_paths": self.test_paths,
            "timeout_setup": self.timeout_setup,
            "timeout_agent": self.timeout_agent,
            "timeout_tests": self.timeout_tests,
            **(
                {"toolchains": list(resolve_toolchains(self.toolchains))}
                if self.toolchains is not None
                else {}
            ),
            "network_mode": self.network_mode,
            "agent_network_mode": self.agent_network_mode,
            "agent_allowed_hosts": self.agent_allowed_hosts,
            "verifier_network_mode": self.verifier_network_mode,
            "cpus": self.cpus,
            "memory_mb": self.memory_mb,
            "storage_mb": self.storage_mb,
        }
        encoded_definition = json.dumps(
            definition,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        return {
            "definition_sha256": hashlib.sha256(encoded_definition).hexdigest(),
            "prompt_sha256": self.prompt_sha256,
            "test_patch_sha256": hashlib.sha256(self.test_patch.encode()).hexdigest(),
            "gold_patch_sha256": hashlib.sha256(self.gold_patch.encode()).hexdigest(),
        }

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
        if not isinstance(message_index, int) or isinstance(message_index, bool) or message_index < 0:
            raise ValueError("prompt_source.message_index must be a non-negative integer")
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
        source_path = (self.dir / relative_path).resolve()
        if not source_path.is_relative_to(self.dir):
            raise ValueError(f"{field_name}.path must stay inside the task directory")
        return source_path, source_format


def load_task(task_dir: str | Path) -> Task:
    task_dir = Path(task_dir).resolve()
    raw = json.loads((task_dir / "task.json").read_text())
    if not isinstance(raw, dict):
        raise ValueError(f"invalid task {task_dir}: task.json must contain an object")
    cfg: dict[str, object] = raw
    problems: list[str] = []

    required_strings = ("task_id", "repo", "base_commit", "workdir", "setup_cmd", "test_cmd")
    for name in required_strings:
        value = cfg.get(name)
        if not isinstance(value, str) or not value.strip():
            problems.append(f"{name} must be a non-empty string")

    list_fields = ("fail_to_pass", "pass_to_pass", "test_paths", "agent_allowed_hosts")
    for name in list_fields:
        if name not in cfg and name in {"pass_to_pass", "agent_allowed_hosts"}:
            continue
        value = cfg.get(name)
        if not isinstance(value, list):
            problems.append(f"{name} must be a list of non-empty strings")
        elif any(not isinstance(item, str) or not item.strip() for item in value):
            problems.append(f"{name} entries must be non-empty strings")

    for name in ("prompt_source", "trace_source", "prompt_generation"):
        value = cfg.get(name)
        if value is not None and not isinstance(value, dict):
            problems.append(f"{name} must be an object")
    if "quality" in cfg and not isinstance(cfg["quality"], dict):
        problems.append("quality must be an object")
    source_pr = cfg.get("source_pr")
    if source_pr is not None and (
        not isinstance(source_pr, int) or isinstance(source_pr, bool) or source_pr <= 0
    ):
        problems.append("source_pr must be a positive integer")
    source_url = cfg.get("source_url")
    if source_url is not None and (not isinstance(source_url, str) or not source_url.strip()):
        problems.append("source_url must be a non-empty string")
    for name in ("network_mode", "agent_network_mode", "verifier_network_mode"):
        value = cfg.get(name)
        if value is not None and not isinstance(value, str):
            problems.append(f"{name} must be a string")
    for name in (
        "timeout_setup",
        "timeout_agent",
        "timeout_tests",
        "cpus",
        "memory_mb",
        "storage_mb",
    ):
        value = cfg.get(name)
        if value is not None and (not isinstance(value, int) or isinstance(value, bool)):
            problems.append(f"{name} must be an integer")

    known_fields = {name for name in Task.__dataclass_fields__ if name != "dir"}
    unknown = sorted(set(cfg) - known_fields)
    if unknown:
        problems.append(f"unknown task field(s): {', '.join(unknown)}")
    missing = [
        name for name in required_strings + ("fail_to_pass", "pass_to_pass", "test_paths")
        if name not in cfg
    ]
    if missing:
        problems.append(f"missing required field(s): {', '.join(missing)}")
    if problems:
        raise ValueError(f"invalid task {task_dir}: " + "; ".join(problems))

    task = Task(dir=task_dir, **raw)
    problems = []
    if not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._-]*",
        task.task_id,
    ):
        problems.append("task_id must be a path-safe identifier")
    workdir = Path(task.workdir)
    if workdir.is_absolute() or ".." in workdir.parts:
        problems.append("workdir must stay inside the repository")
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
            trace_path, _ = task._trace_source_values(task.trace_source)
            if not trace_path.is_file():
                problems.append(f"trace_source does not exist: {trace_path}")
        except ValueError as exc:
            problems.append(str(exc))
    if task.prompt_generation is not None and (has_prompt_file or task.prompt_source is not None):
        try:
            if task.prompt_generation.get("prompt_sha256") != task.prompt_sha256:
                problems.append("prompt.md does not match prompt_generation.prompt_sha256")
        except (OSError, ValueError) as exc:
            problems.append(str(exc))
    for name in ("test.patch", "gold.patch"):
        if not (task_dir / name).is_file():
            problems.append(f"missing {name}")
    if not task.test_paths:
        problems.append("test_paths must list the files/dirs the test patch touches")
    else:
        for test_path in task.test_paths:
            path = Path(test_path)
            if path == Path(".") or path.is_absolute() or ".." in path.parts:
                problems.append("test_paths entries must stay inside the repository")
                break
    for timeout_name in ("timeout_setup", "timeout_agent", "timeout_tests"):
        timeout = getattr(task, timeout_name)
        if timeout <= 0:
            problems.append(f"{timeout_name} must be a positive integer")
    try:
        resolve_toolchains(task.toolchains)
    except ValueError as exc:
        problems.append(str(exc))
    for mode_name in ("network_mode", "agent_network_mode", "verifier_network_mode"):
        if getattr(task, mode_name) not in {"public", "no-network", "allowlist"}:
            problems.append(f"{mode_name} must be public, no-network, or allowlist")
    if task.agent_allowed_hosts and task.agent_network_mode != "allowlist":
        problems.append("agent_allowed_hosts requires agent_network_mode=allowlist")
    for resource_name in ("cpus", "memory_mb", "storage_mb"):
        value = getattr(task, resource_name)
        if value <= 0:
            problems.append(f"{resource_name} must be a positive integer")
    if problems:
        raise ValueError(f"invalid task {task_dir}: " + "; ".join(problems))
    return task
