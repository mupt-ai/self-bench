"""Extract engineer-authored prompts from agent session exports."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


SUPPORTED_FORMATS = {"auto", "codex", "claude-code", "pi", "generic"}
_TRACE_CONTENT_LIMIT = 50_000


def extract_prompt(path: Path, *, source_format: str = "auto", message_index: int = 0) -> str:
    resolved_format, messages = _extract_messages(path, source_format)
    prompts = [content.strip() for role, content in messages if role == "user" and content.strip()]
    if not prompts:
        raise ValueError(f"no engineer-authored messages found in {path} using {resolved_format} format")

    try:
        return _redact_secrets(prompts[message_index])
    except IndexError as exc:
        raise ValueError(
            f"message_index {message_index} is out of range for {path}; found {len(prompts)} user message(s)"
        ) from exc


def extract_trace(path: Path, *, source_format: str = "auto") -> dict[str, object]:
    """Return human and assistant text from a source coding session.

    Tool results, injected instructions, and non-text blocks are intentionally omitted.
    The trace is for prompt provenance review and is never sent to an eval agent.
    """
    resolved_format, messages = _extract_messages(path, source_format)
    trace_messages: list[dict[str, object]] = []
    user_message_index = 0
    for role, raw_content in messages:
        content = _redact_secrets(raw_content.strip())
        if not content:
            continue
        if len(content) > _TRACE_CONTENT_LIMIT:
            content = content[:_TRACE_CONTENT_LIMIT] + "\n\n[truncated in source-session review]"
        message: dict[str, object] = {"role": role, "content": content}
        if role == "user":
            message["user_message_index"] = user_message_index
            user_message_index += 1
        trace_messages.append(message)
    return {"format": resolved_format, "messages": trace_messages}


def _extract_messages(path: Path, source_format: str) -> tuple[str, list[tuple[str, str]]]:
    if source_format not in SUPPORTED_FORMATS:
        supported = ", ".join(sorted(SUPPORTED_FORMATS))
        raise ValueError(f"unsupported prompt source format {source_format!r}; expected one of {supported}")

    records = _read_records(path)
    resolved_format = _detect_format(records) if source_format == "auto" else source_format
    extractors = {
        "codex": _codex_trace,
        "claude-code": _claude_code_trace,
        "pi": _pi_trace,
        "generic": _generic_trace,
    }
    messages = [
        (role, content)
        for role, content in extractors[resolved_format](records)
        if content.strip() and (role != "user" or not _looks_injected(content))
    ]
    return resolved_format, messages


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


def _codex_trace(records: list[dict[str, Any]]) -> list[tuple[str, str]]:
    event_messages: list[tuple[str, str]] = []
    for record in records:
        payload = record.get("payload")
        if record.get("type") != "event_msg" or not isinstance(payload, dict):
            continue
        role = {"user_message": "user", "agent_message": "assistant"}.get(payload.get("type"))
        message = payload.get("message")
        if role is not None and isinstance(message, str):
            event_messages.append((role, message))
    if any(role == "user" for role, _ in event_messages):
        return event_messages

    messages: list[tuple[str, str]] = []
    for record in records:
        payload = record.get("payload")
        if not isinstance(payload, dict):
            continue
        if record.get("type") != "response_item" or payload.get("type") != "message":
            continue
        role = payload.get("role")
        if role not in {"user", "assistant"}:
            continue
        content = _content_text(payload.get("content"))
        if content:
            messages.append((role, content))
    return messages


def _claude_code_trace(records: list[dict[str, Any]]) -> list[tuple[str, str]]:
    messages: list[tuple[str, str]] = []
    for record in records:
        record_type = record.get("type")
        if record_type not in {"user", "assistant"}:
            continue
        if record_type == "user" and record.get("sourceToolAssistantUUID") is not None:
            continue
        message = record.get("message")
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role not in {"user", "assistant"}:
            continue
        content = _content_text(message.get("content"))
        if content:
            messages.append((role, content))
    return messages


def _pi_trace(records: list[dict[str, Any]]) -> list[tuple[str, str]]:
    messages: list[tuple[str, str]] = []
    for record in records:
        if record.get("type") != "message":
            continue
        message = record.get("message")
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role not in {"user", "assistant"}:
            continue
        content = _content_text(message.get("content"))
        if content:
            messages.append((role, content))
    return messages


def _generic_trace(records: list[dict[str, Any]]) -> list[tuple[str, str]]:
    messages: list[tuple[str, str]] = []
    for record in records:
        role = record.get("role")
        content = record.get("content")
        if role in {"user", "assistant"}:
            text = _content_text(content)
            if text:
                messages.append((role, text))
            continue

        message = record.get("message")
        if not isinstance(message, dict) or message.get("role") not in {"user", "assistant"}:
            continue
        text = _content_text(message.get("content"))
        if text:
            messages.append((str(message["role"]), text))
    return messages


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
            "# Review Guidelines",
            "<environment_context>",
            "<permissions instructions>",
            "<collaboration_mode>",
            "<skills_instructions>",
            "<apps_instructions>",
            "<plugins_instructions>",
            "<skill name=",
            "Base directory for this skill:",
            "## Memory",
        )
    )


def _redact_secrets(value: str) -> str:
    patterns = (
        (r"\bdari_[A-Za-z0-9_-]{16,}", "dari_[REDACTED]"),
        (r"\bsk-[A-Za-z0-9_-]{16,}", "sk-[REDACTED]"),
        (r"\b(?:ghp|github_pat)_[A-Za-z0-9_-]{16,}", "github_[REDACTED]"),
    )
    for pattern, replacement in patterns:
        value = re.sub(pattern, replacement, value)
    return value
