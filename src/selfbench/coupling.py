"""Independent LLM review for gold-coupled held-out tests.

Validation proves the gold patch passes; the static audit catches shallow
coupling heuristically. This module adds the third gate: a fresh model pass
with no authoring context that judges whether an equivalent-but-different
correct implementation could pass the held-out tests.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from .task import Task

REVIEWER_VERSION = "coupling-review-v1"
VERDICTS = ("clean", "minor", "coupled")
_MAX_PATCH_CHARS = 120_000


def build_coupling_request(task: Task) -> str:
    """Build the reviewer prompt. It must contain only eval-visible material
    plus the two held-out patches — never the source session or PR metadata."""
    return f"""You are auditing one SWE-bench-style benchmark task for "gold coupling": held-out tests that require identifiers, signatures, or output shapes introduced only by the reference (gold) implementation, which a solver working from the prompt and a clean checkout could not plausibly produce.

The solving model sees ONLY the work request below and a clean repository checkout at the base commit. It never sees the gold patch or the tests.

Judge every identifier, signature, dictionary shape, header value, error message, and dependency the tests rely on:
- OK: named in the work request, dictated by a public spec (RFC, PEP, OpenAPI), or a pre-existing repository convention a solver can read in the checkout.
- GUESSABLE: not named, but the only reasonable conventional choice; an equivalent implementation would land on it.
- COUPLED: an equivalent correct implementation could reasonably differ and would fail — private helpers, gold-only public API shapes, verbatim new error strings, exact non-spec output shapes, or load-bearing dependency additions/upgrades the request never conveys.

Also check: does the fix require a dependency manifest change (package.json, pyproject.toml, lockfiles) that the request does not convey? That is COUPLED.

Only the graded tests matter. The patch below may add helper code or extra tests that are never graded; judge ONLY the tests selected by these graded selectors:
- fail-to-pass (must fail before the fix and pass after): {json.dumps(task.fail_to_pass)}
- pass-to-pass (must keep passing): {json.dumps(task.pass_to_pass)}
Ignore coupling in any test the selectors do not run.

Respond with ONLY a JSON object, no prose and no code fences:
{{
  "verdict": "clean" | "minor" | "coupled",
  "findings": [
    {{"identifier": "<name or shape>", "classification": "guessable" | "coupled", "reason": "<one line>"}}
  ],
  "summary": "<one or two sentences>"
}}
Use "clean" when every reference is OK, "minor" when the worst finding is guessable, "coupled" when any finding is coupled.

WORK REQUEST (all the solver sees)
{task.prompt.strip()}
END WORK REQUEST

HELD-OUT TEST PATCH
{_truncate(task.test_patch, _MAX_PATCH_CHARS)}
END HELD-OUT TEST PATCH

GOLD PATCH (reference implementation; the solver never sees this)
{_truncate(task.gold_patch, _MAX_PATCH_CHARS)}
END GOLD PATCH
"""


def review_coupling(
    task: Task,
    *,
    provider: str,
    model: str,
    thinking: str | None = None,
    pi_executable: str | None = None,
) -> dict[str, object]:
    request = build_coupling_request(task)
    pi = pi_executable or shutil.which("pi")
    if not pi:
        raise RuntimeError("pi is required to run the coupling review")
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
        raise RuntimeError(f"coupling reviewer exited {result.returncode}: {output[-3000:]}")
    review = _parse_review(result.stdout)
    review["request_sha256"] = hashlib.sha256(request.encode()).hexdigest()
    return review


def save_coupling_review(
    task: Task,
    review: dict[str, object],
    *,
    provider: str,
    model: str,
) -> Path:
    payload = {
        "reviewer_version": REVIEWER_VERSION,
        "provider": provider,
        "model": model,
        "reviewed_at": datetime.now(UTC).isoformat(),
        "task_fingerprints": _review_fingerprints(task),
        **review,
    }
    path = task.dir / "coupling_review.json"
    path.write_text(json.dumps(payload, indent=2) + "\n")
    return path


def load_coupling_review(task: Task) -> dict[str, object] | None:
    path = task.dir / "coupling_review.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError:
        return {"verdict": "unreadable"}
    if not isinstance(data, dict):
        return {"verdict": "unreadable"}
    if data.get("task_fingerprints") != _review_fingerprints(task):
        return {**data, "stale": True}
    return data


def _review_fingerprints(task: Task) -> dict[str, str]:
    return {
        "prompt": hashlib.sha256(task.prompt.encode()).hexdigest(),
        "test_patch": hashlib.sha256(task.test_patch.encode()).hexdigest(),
        "gold_patch": hashlib.sha256(task.gold_patch.encode()).hexdigest(),
    }


def _parse_review(stdout: str) -> dict[str, object]:
    text = stdout.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, flags=re.DOTALL)
    if fenced:
        text = fenced.group(1)
    else:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end <= start:
            raise ValueError(f"coupling reviewer returned no JSON object: {text[:300]!r}")
        text = text[start : end + 1]
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"coupling reviewer returned invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("coupling reviewer returned a non-object JSON value")
    verdict = data.get("verdict")
    if verdict not in VERDICTS:
        raise ValueError(f"coupling reviewer returned unknown verdict: {verdict!r}")
    findings = data.get("findings")
    if findings is None:
        data["findings"] = []
    elif not isinstance(findings, list):
        raise ValueError("coupling reviewer findings must be a list")
    return data


def _truncate(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[:limit] + "\n[patch truncated for review]"
