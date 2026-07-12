"""Extract engineer-authored prompts from agent session exports."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


SUPPORTED_FORMATS = {"auto", "codex", "claude-code", "pi", "generic"}


def extract_prompt(path: Path, *, source_format: str = "auto", message_index: int = 0) -> str:
    if source_format not in SUPPORTED_FORMATS:
        supported = ", ".join(sorted(SUPPORTED_FORMATS))
        raise ValueError(f"unsupported prompt source format {source_format!r}; expected one of {supported}")

    records = _read_records(path)
    resolved_format = _detect_format(records) if source_format == "auto" else source_format
    extractors = {
        "codex": _codex_prompts,
        "claude-code": _claude_code_prompts,
        "pi": _pi_prompts,
        "generic": _generic_prompts,
    }
    prompts = [prompt.strip() for prompt in extractors[resolved_format](records) if prompt.strip()]
    if not prompts:
        raise ValueError(f"no engineer-authored messages found in {path} using {resolved_format} format")

    try:
        return prompts[message_index]
    except IndexError as exc:
        raise ValueError(
            f"message_index {message_index} is out of range for {path}; found {len(prompts)} user message(s)"
        ) from exc


def _read_records(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise ValueError(f"prompt source does not exist: {path}")

    raw = path.read_text()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        records: list[dict[str, Any]] = []
        for line_number, line in enumerate(raw.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSON on line {line_number} of {path}: {exc.msg}") from exc
            if isinstance(value, dict):
                records.append(value)
        return records

    if isinstance(data, list):
        return [value for value in data if isinstance(value, dict)]
    if not isinstance(data, dict):
        raise ValueError(f"prompt source must contain a JSON object, array, or JSONL records: {path}")
    messages = data.get("messages")
    if isinstance(messages, list):
        return [value for value in messages if isinstance(value, dict)]
    return [data]


def _detect_format(records: list[dict[str, Any]]) -> str:
    if any(record.get("type") in {"event_msg", "response_item", "session_meta"} for record in records):
        return "codex"
    if any("sessionId" in record and record.get("type") in {"user", "assistant"} for record in records):
        return "claude-code"
    if any(record.get("type") == "message" and "parentId" in record for record in records):
        return "pi"
    return "generic"


def _codex_prompts(records: list[dict[str, Any]]) -> list[str]:
    event_prompts = []
    for record in records:
        payload = record.get("payload")
        if not isinstance(payload, dict):
            continue
        if record.get("type") == "event_msg" and payload.get("type") == "user_message":
            message = payload.get("message")
            if isinstance(message, str):
                event_prompts.append(message)
    if event_prompts:
        return event_prompts

    prompts = []
    for record in records:
        payload = record.get("payload")
        if not isinstance(payload, dict):
            continue
        if record.get("type") != "response_item" or payload.get("type") != "message":
            continue
        if payload.get("role") != "user":
            continue
        prompt = _content_text(payload.get("content"))
        if prompt and not _looks_injected(prompt):
            prompts.append(prompt)
    return prompts


def _claude_code_prompts(records: list[dict[str, Any]]) -> list[str]:
    prompts = []
    for record in records:
        if record.get("type") != "user" or record.get("sourceToolAssistantUUID") is not None:
            continue
        message = record.get("message")
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        prompt = _content_text(message.get("content"))
        if prompt:
            prompts.append(prompt)
    return prompts


def _pi_prompts(records: list[dict[str, Any]]) -> list[str]:
    prompts = []
    for record in records:
        if record.get("type") != "message":
            continue
        message = record.get("message")
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        prompt = _content_text(message.get("content"))
        if prompt:
            prompts.append(prompt)
    return prompts


def _generic_prompts(records: list[dict[str, Any]]) -> list[str]:
    prompts = []
    for record in records:
        role = record.get("role")
        content = record.get("content")
        if role == "user":
            prompt = _content_text(content)
            if prompt:
                prompts.append(prompt)
            continue

        message = record.get("message")
        if isinstance(message, dict) and message.get("role") == "user":
            prompt = _content_text(message.get("content"))
            if prompt:
                prompts.append(prompt)
    return prompts


def _content_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""

    parts = []
    for item in content:
        if isinstance(item, str):
            parts.append(item)
            continue
        if not isinstance(item, dict) or item.get("type") not in {"text", "input_text"}:
            continue
        text = item.get("text")
        if isinstance(text, str):
            parts.append(text)
    return "\n\n".join(parts)


def _looks_injected(prompt: str) -> bool:
    stripped = prompt.lstrip()
    return stripped.startswith(
        (
            "# AGENTS.md instructions",
            "<environment_context>",
            "<permissions instructions>",
            "<collaboration_mode>",
            "<skills_instructions>",
            "<apps_instructions>",
            "<plugins_instructions>",
            "## Memory",
        )
    )
