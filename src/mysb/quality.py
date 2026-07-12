"""Benchmark quality audit helpers.

Validation proves that a task is executable. This module adds the second gate:
curation checks that catch common SWE-Bench-style failure modes before a task is
allowed into the headline benchmark set.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .task import Task

DEFAULT_SIGNAL_MODELS = ("openai__gpt-5.5", "fireworks__glm-5p2")


@dataclass
class AuditResult:
    task_id: str
    verdict: str
    validation: str
    solver_signal: str
    model_results: dict[str, str]
    blockers: list[str]
    warnings: list[str]

    def as_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "verdict": self.verdict,
            "validation": self.validation,
            "solver_signal": self.solver_signal,
            "model_results": self.model_results,
            "blockers": self.blockers,
            "warnings": self.warnings,
        }


@dataclass
class PatchStats:
    files: set[str]
    added_lines: int


def audit_task(task: Task, results_root: Path, model_slugs: list[str]) -> AuditResult:
    blockers: list[str] = []
    warnings: list[str] = []

    validation = _validation_status(results_root / task.task_id / "validation" / "result.json")
    if validation != "valid":
        blockers.append(f"validation result is {validation}")

    if not task.pass_to_pass:
        blockers.append("pass_to_pass is empty; accepted tasks need regression coverage")
    elif len(task.pass_to_pass) < 3:
        warnings.append("pass_to_pass has fewer than 3 entries")

    prompt_words = len(re.findall(r"\w+", task.prompt))
    if prompt_words < 80:
        blockers.append("prompt is too short to be a well-specified work item")
    elif prompt_words > 750:
        warnings.append("prompt is very long; check for over-specification or solution leakage")

    test_stats = _patch_stats(task.test_patch)
    gold_stats = _patch_stats(task.gold_patch)
    if not test_stats.files:
        blockers.append("test.patch touches no files")
    if not gold_stats.files:
        blockers.append("gold.patch touches no files")

    overlap = sorted(test_stats.files & gold_stats.files)
    if overlap:
        blockers.append("test and gold patches touch the same file(s): " + ", ".join(overlap[:3]))

    uncovered = sorted(p for p in test_stats.files if not _covered_by_test_paths(p, task.test_paths))
    if uncovered:
        blockers.append("test_paths does not cover test.patch file(s): " + ", ".join(uncovered[:3]))

    leaked_tests = sorted(_test_names(task.fail_to_pass, task.test_patch) & _prompt_words(task.prompt))
    if leaked_tests:
        blockers.append("prompt leaks held-out test name(s): " + ", ".join(leaked_tests[:5]))

    forbidden_terms = _forbidden_prompt_terms(task.prompt)
    if forbidden_terms:
        warnings.append("prompt contains source-artifact wording: " + ", ".join(forbidden_terms))

    leaked_identifiers = sorted(_new_identifiers(task.gold_patch) & _prompt_words(task.prompt))
    if leaked_identifiers:
        warnings.append(
            "prompt mentions identifier(s) introduced by gold.patch; review for solution leakage: "
            + ", ".join(leaked_identifiers[:8])
        )

    brittle = _brittle_test_signals(task.test_patch)
    if brittle:
        warnings.extend(brittle[:5])

    if gold_stats.added_lines >= 200 and len(task.fail_to_pass) <= 1:
        warnings.append(
            f"large gold patch ({gold_stats.added_lines} added lines) with only "
            f"{len(task.fail_to_pass)} fail_to_pass entry"
        )

    model_results = _model_results(results_root, task.task_id, model_slugs)
    solver_signal = _solver_signal(model_results)
    if solver_signal == "missing":
        warnings.append("missing one or more standard model runs")
    elif solver_signal == "single_model":
        warnings.append("need at least two model runs to measure task signal")
    elif solver_signal == "all_solved":
        warnings.append("all standard models solved this task; do not count it in headline signal")
    elif solver_signal == "none_solved":
        warnings.append("no standard model solved this task; inspect traces for brittleness or missing context")

    warnings = _suppress_reviewed_warnings(warnings, task.quality)

    if blockers:
        verdict = "rejected"
    elif solver_signal == "mixed":
        verdict = "accepted"
    else:
        verdict = "needs_review"

    return AuditResult(
        task_id=task.task_id,
        verdict=verdict,
        validation=validation,
        solver_signal=solver_signal,
        model_results=model_results,
        blockers=blockers,
        warnings=warnings,
    )


def _validation_status(path: Path) -> str:
    if not path.is_file():
        return "missing"
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError:
        return "unreadable"
    return "valid" if data.get("valid") is True else "invalid"


def _model_results(results_root: Path, task_id: str, model_slugs: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for slug in model_slugs:
        path = results_root / task_id / slug / "result.json"
        if not path.is_file():
            out[slug] = "missing"
            continue
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError:
            out[slug] = "unreadable"
            continue
        out[slug] = "pass" if data.get("resolved") is True else "fail"
    return out


def _solver_signal(model_results: dict[str, str]) -> str:
    outcomes = list(model_results.values())
    if any(v in {"missing", "unreadable"} for v in outcomes):
        return "missing"
    solved = sum(v == "pass" for v in outcomes)
    total = len(outcomes)
    if total < 2:
        return "single_model"
    if solved == 0:
        return "none_solved"
    if solved == total:
        return "all_solved"
    return "mixed"


def _patch_stats(patch: str) -> PatchStats:
    files: set[str] = set()
    added = 0
    for line in patch.splitlines():
        if line.startswith("diff --git "):
            parts = line.split()
            if len(parts) >= 4 and parts[3].startswith("b/"):
                files.add(parts[3][2:])
        elif line.startswith("+") and not line.startswith("+++"):
            added += 1
    return PatchStats(files=files, added_lines=added)


def _covered_by_test_paths(path: str, test_paths: list[str]) -> bool:
    for root in test_paths:
        root = root.rstrip("/")
        if path == root or path.startswith(root + "/"):
            return True
    return False


def _prompt_words(prompt: str) -> set[str]:
    return set(re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", prompt))


def _test_names(fail_to_pass: list[str], test_patch: str) -> set[str]:
    names: set[str] = set()
    for entry in fail_to_pass:
        if "::" in entry:
            names.add(entry.rsplit("::", 1)[1].split("[")[0])
        for token in re.findall(r"Test[A-Za-z0-9_]+|test_[A-Za-z0-9_]+", entry):
            names.add(token)
    for line in test_patch.splitlines():
        if not line.startswith("+") or line.startswith("+++"):
            continue
        for pattern in (
            r"\b(?:async\s+def|def)\s+(test_[A-Za-z0-9_]+)",
            r"\bfunc\s+(Test[A-Za-z0-9_]+)",
        ):
            match = re.search(pattern, line)
            if match:
                names.add(match.group(1))
    return names


def _new_identifiers(gold_patch: str) -> set[str]:
    identifiers: set[str] = set()
    patterns = (
        r"\b(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)",
        r"\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)",
        r"\b(?:function|interface|type)\s+([A-Za-z_][A-Za-z0-9_]*)",
        r"\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)",
    )
    for line in gold_patch.splitlines():
        if not line.startswith("+") or line.startswith("+++"):
            continue
        for pattern in patterns:
            match = re.search(pattern, line)
            if not match:
                continue
            name = match.group(1)
            if not name.startswith("_") and len(name) >= 4 and name not in _IDENTIFIER_STOPWORDS:
                identifiers.add(name)
    return identifiers


_IDENTIFIER_STOPWORDS = {
    "content",
    "context",
    "data",
    "error",
    "input",
    "item",
    "kind",
    "message",
    "model",
    "options",
    "output",
    "payload",
    "request",
    "response",
    "result",
    "value",
}


def _forbidden_prompt_terms(prompt: str) -> list[str]:
    lowered = prompt.lower()
    terms = []
    patterns = {
        "gold.patch": r"\bgold\.patch\b",
        "test.patch": r"\btest\.patch\b",
        "diff": r"\bdiff\b",
        "merge commit": r"\bmerge commit\b",
        "pr #": r"\bpr\s*#",
        "pull request #": r"\bpull request\s*#",
    }
    for term, pattern in patterns.items():
        if re.search(pattern, lowered):
            terms.append(term)
    return terms


def _brittle_test_signals(test_patch: str) -> list[str]:
    warnings: list[str] = []
    added = [line[1:].strip() for line in test_patch.splitlines() if line.startswith("+") and not line.startswith("+++")] 
    exact_string_count = 0
    exact_structure_count = 0
    for line in added:
        if re.search(r"\bassert\b.+==\s*[\"'][^\"']{40,}[\"']", line):
            exact_string_count += 1
        if re.search(r"\bassert\b.+==\s*[{[]\s*$", line):
            exact_structure_count += 1
        if re.search(r"\b(toMatchSnapshot|assert_snapshot|golden output)\b", line, flags=re.IGNORECASE):
            warnings.append("test patch uses snapshot/golden-output assertions; review for over-constraint")
            break
    if exact_string_count:
        warnings.append(f"test patch has {exact_string_count} long exact-string assertion(s)")
    if exact_structure_count:
        warnings.append(
            f"test patch has {exact_structure_count} exact structure assertion(s); review for over-constraint"
        )
    if any(re.search(r"\b(?:time\.sleep|asyncio\.sleep|setTimeout)\b", line) for line in added):
        warnings.append("test patch uses sleeps/timeouts; review for flake risk")
    if any(re.search(r"\b(?:requests|httpx|socket|postgres|redis)\b", line) for line in added):
        warnings.append("test patch references network/service dependencies; verify sandbox determinism")
    return warnings


def _suppress_reviewed_warnings(warnings: list[str], quality: dict[str, object]) -> list[str]:
    reviewed = quality.get("reviewed_warnings")
    if not isinstance(reviewed, list):
        return warnings
    tokens = [str(item) for item in reviewed if str(item)]
    if not tokens:
        return warnings
    return [warning for warning in warnings if not any(token in warning for token in tokens)]


def format_audit_markdown(results: list[AuditResult], model_slugs: list[str]) -> str:
    lines = [
        "| task | verdict | validation | solver signal | "
        + " | ".join(model_slugs)
        + " | notes |",
        "|---" * (5 + len(model_slugs)) + "|",
    ]
    icon = {"pass": "✅", "fail": "❌", "missing": "—", "unreadable": "?"}
    for result in sorted(results, key=lambda r: r.task_id):
        notes = result.blockers or result.warnings
        note_text = "; ".join(notes[:3])
        if len(note_text) > 180:
            note_text = note_text[:177] + "..."
        row = [
            result.task_id,
            result.verdict,
            result.validation,
            result.solver_signal,
            *(icon.get(result.model_results.get(slug, "missing"), "?") for slug in model_slugs),
            note_text.replace("|", "\\|"),
        ]
        lines.append("| " + " | ".join(row) + " |")
    counts: dict[str, int] = {}
    for result in results:
        counts[result.verdict] = counts.get(result.verdict, 0) + 1
    lines.append("")
    lines.append(
        "Verdicts: "
        + ", ".join(f"{name}={count}" for name, count in sorted(counts.items()))
    )
    return "\n".join(lines)
