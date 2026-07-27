"""Generate standalone eval prompts from private source coding sessions."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from .task import Task

GENERATOR_VERSION = "user-voice-v1"
_MAX_HUMAN_TURN_CHARS = 15_000
_MAX_ASSISTANT_CONTEXT_CHARS = 3_000
_MAX_CONVERSATION_CHARS = 120_000


def build_generation_request(task: Task) -> str:
    trace = task.source_trace
    if trace is None:
        raise ValueError(f"task {task.task_id} has no source coding session")
    messages = trace.get("messages")
    if not isinstance(messages, list):
        raise ValueError(f"task {task.task_id} has an invalid source coding session")

    conversation = _conversation_excerpt(messages)
    return f"""You are converting an authentic coding-agent conversation into one standalone software-engineering work request for an evaluation.

Write the request as if the original human requester had sent one coherent message before implementation began.

Voice and fidelity:
- Preserve the human's directness, terminology, priorities, uncertainty, and level of formality.
- Clean up typos only when needed for readability. Do not turn a casual request into corporate product-spec prose.
- Fold later human corrections and clarifications into the request when they materially changed the task.
- Do not invent requirements, edge cases, or acceptance criteria that the human did not ask for or clearly endorse.

Make it standalone:
- Resolve references such as “this”, “that error”, or “the current behavior” using context established in the conversation.
- Include enough observed behavior and desired outcome for an engineer with the repository to start investigating.
- Remove requests to commit, push, open a PR, monitor CI, send a link, explain completed work, or perform deployment follow-up.
- Remove credentials, private operational identifiers, and unrelated conversation turns.

Protect the evaluation:
- Do not mention this source conversation, an eval, a gold patch, a test patch, hidden tests, or the completed implementation.
- Do not copy implementation details, file names, symbols, algorithms, or solution steps that appear only in assistant messages.
- Assistant messages are context for resolving what the human meant, not an authoritative source of new requirements.
- Do not ask the agent to change tests.

Output only the final work request. Do not add a preface, analysis, quotation marks, or a title like “Generated prompt”. Aim for roughly 100–350 words unless the authentic request genuinely needs more detail.

Repository: {task.repo}
Working area: {task.workdir}

SOURCE CONVERSATION
{conversation}
END SOURCE CONVERSATION
"""


def generate_prompt(
    task: Task,
    *,
    provider: str,
    model: str,
    thinking: str | None = None,
    pi_executable: str | None = None,
) -> tuple[str, str]:
    request = build_generation_request(task)
    pi = pi_executable or shutil.which("pi")
    if not pi:
        raise RuntimeError("pi is required to generate prompts")
    command = [
        pi,
        "-p",
        "--no-session",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--provider",
        provider,
        "--model",
        model,
    ]
    if thinking:
        command.extend(["--thinking", thinking])
    command.append(request)
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        output = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"prompt generator exited {result.returncode}: {output[-3000:]}")
    prompt = result.stdout.strip()
    _validate_generated_prompt(prompt)
    return prompt, hashlib.sha256(request.encode()).hexdigest()


def save_generated_prompt(
    task: Task,
    prompt: str,
    *,
    provider: str,
    model: str,
    request_sha256: str,
) -> Path:
    _validate_generated_prompt(prompt)
    config_path = task.dir / "task.json"
    config = json.loads(config_path.read_text())
    if not isinstance(config, dict):
        raise ValueError(f"cannot read {config_path}")

    prompt_source = config.pop("prompt_source", None)
    if "trace_source" not in config and isinstance(prompt_source, dict):
        trace_source = {
            key: prompt_source[key]
            for key in ("path", "format")
            if key in prompt_source
        }
        config["trace_source"] = trace_source

    prompt_path = task.dir / "prompt.md"
    normalized_prompt = prompt.rstrip() + "\n"
    prompt_path.write_text(normalized_prompt)
    config["prompt_generation"] = {
        "generator_version": GENERATOR_VERSION,
        "provider": provider,
        "model": model,
        "generated_at": datetime.now(UTC).isoformat(),
        "source_trace_sha256": _source_trace_sha256(task),
        "human_turn_indices": _human_turn_indices(task),
        "assistant_context_used": True,
        "request_sha256": request_sha256,
        "prompt_sha256": hashlib.sha256(normalized_prompt.encode()).hexdigest(),
    }
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    return prompt_path


def _conversation_excerpt(messages: list[object]) -> str:
    turns: list[tuple[str, list[str]]] = []
    current_assistant: list[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = message.get("content")
        if role not in {"user", "assistant"} or not isinstance(content, str) or not content.strip():
            continue
        sanitized = _sanitize_source_text(content.strip())
        if role == "user":
            if turns and current_assistant:
                turns[-1][1].append(current_assistant[-1])
            turns.append((sanitized, []))
            current_assistant = []
        elif turns:
            current_assistant.append(sanitized)
    if turns and current_assistant:
        turns[-1][1].append(current_assistant[-1])
    if not turns:
        raise ValueError("source coding session contains no human-authored turns")

    blocks: list[str] = []
    for index, (human, assistant) in enumerate(turns, start=1):
        human = _truncate(human, _MAX_HUMAN_TURN_CHARS)
        block = f"HUMAN TURN {index}\n{human}"
        if assistant:
            block += "\n\nASSISTANT RESPONSE CONTEXT\n" + _truncate(
                assistant[-1], _MAX_ASSISTANT_CONTEXT_CHARS
            )
        blocks.append(block)

    conversation = "\n\n---\n\n".join(blocks)
    if len(conversation) <= _MAX_CONVERSATION_CHARS:
        return conversation
    return conversation[:_MAX_CONVERSATION_CHARS] + "\n\n[conversation excerpt truncated]"


def _truncate(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[:limit] + "\n[truncated]"


def _sanitize_source_text(value: str) -> str:
    value = re.sub(
        r"https?://github\.com/[^\s]+/pull/\d+(?:[^\s]*)?",
        "[pull request omitted]",
        value,
        flags=re.IGNORECASE,
    )
    return re.sub(
        r"\b(?:PR|pull request)\s*#?\d+\b",
        "[pull request omitted]",
        value,
        flags=re.IGNORECASE,
    )


def _validate_generated_prompt(prompt: str) -> None:
    if not prompt.strip():
        raise ValueError("generated prompt is empty")
    word_count = len(prompt.split())
    if word_count < 60:
        raise ValueError(f"generated prompt is too short ({word_count} words)")
    if word_count > 750:
        raise ValueError(f"generated prompt is too long ({word_count} words)")
    lowered = prompt.lower()
    forbidden = (
        "source conversation",
        "gold patch",
        "test patch",
        "hidden tests",
        "generated prompt",
    )
    found = [term for term in forbidden if term in lowered]
    if found:
        raise ValueError("generated prompt contains forbidden provenance terms: " + ", ".join(found))


def _source_trace_sha256(task: Task) -> str:
    trace = task.source_trace
    if trace is None:
        raise ValueError(f"task {task.task_id} has no source coding session")
    payload = json.dumps(trace, sort_keys=True, ensure_ascii=False).encode()
    return hashlib.sha256(payload).hexdigest()


def _human_turn_indices(task: Task) -> list[int]:
    trace = task.source_trace
    if trace is None:
        raise ValueError(f"task {task.task_id} has no source coding session")
    messages = trace.get("messages", [])
    return [
        message["user_message_index"]
        for message in messages
        if isinstance(message, dict)
        and message.get("role") == "user"
        and isinstance(message.get("user_message_index"), int)
    ]
