"""mysb CLI: validate tasks, run rollouts, aggregate reports."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .quality import DEFAULT_SIGNAL_MODELS, audit_task, format_audit_markdown
from .review import cmd_review
from .runner import run_task, save_result, validate_task
from .task import load_task


def _model_slug(provider: str, model: str) -> str:
    return f"{provider}__{model.split('/')[-1]}"


def cmd_validate(args: argparse.Namespace) -> int:
    task = load_task(args.task_dir)
    result = validate_task(task, Path(args.repo).resolve(), verbose=not args.quiet)
    path = save_result(result, Path(args.results), "validation")
    print(json.dumps({k: result[k] for k in ("task_id", "valid", "checks", "duration_s")}, indent=2))
    print(f"full result: {path}")
    return 0 if result["valid"] else 1


def cmd_run(args: argparse.Namespace) -> int:
    task = load_task(args.task_dir)
    result = run_task(
        task,
        Path(args.repo).resolve(),
        provider=args.provider,
        model=args.model,
        thinking=args.thinking,
        verbose=not args.quiet,
    )
    path = save_result(result, Path(args.results), _model_slug(args.provider, args.model))
    summary = {
        k: result[k]
        for k in ("task_id", "provider", "model", "resolved", "failure_reasons",
                  "fail_to_pass_passed", "pass_to_pass_passed", "agent_exit_ok",
                  "agent_patch_applied", "duration_s")
    }
    print(json.dumps(summary, indent=2))
    print(f"full result: {path}")
    return 0 if result["resolved"] else 1


def cmd_report(args: argparse.Namespace) -> int:
    root = Path(args.results)
    allowed_task_ids: set[str] | None = None
    if args.verdict:
        audit_models = args.models or list(DEFAULT_SIGNAL_MODELS)
        audits = [
            audit_task(load_task(task_dir), root, audit_models)
            for task_dir in _iter_task_dirs(args.tasks)
        ]
        allowed_task_ids = {r.task_id for r in audits if r.verdict in args.verdict}

    rows: dict[str, dict[str, str]] = {}
    models: set[str] = set(args.models or [])
    for rj in sorted(root.glob("*/*/result.json")):
        r = json.loads(rj.read_text())
        run_name = rj.parent.name
        if run_name == "validation":
            continue
        if args.models and run_name not in args.models:
            continue
        task_id = r["task_id"]
        if allowed_task_ids is not None and task_id not in allowed_task_ids:
            continue
        models.add(run_name)
        rows.setdefault(task_id, {})[run_name] = "✅" if r["resolved"] else "❌"
    if not rows:
        print(f"no run results under {root}")
        return 1
    cols = sorted(models)
    print("| task | " + " | ".join(cols) + " |")
    print("|---" * (len(cols) + 1) + "|")
    for task_id, per_model in sorted(rows.items()):
        print(f"| {task_id} | " + " | ".join(per_model.get(m, "—") for m in cols) + " |")
    totals = [
        f"{sum(1 for r in rows.values() if r.get(m) == '✅')}/{sum(1 for r in rows.values() if m in r)}"
        for m in cols
    ]
    print("| **resolved** | " + " | ".join(totals) + " |")
    return 0


def _iter_task_dirs(paths: list[str]) -> list[Path]:
    task_dirs: list[Path] = []
    for raw in paths:
        path = Path(raw)
        if (path / "task.json").is_file():
            task_dirs.append(path)
            continue
        task_dirs.extend(sorted(p for p in path.iterdir() if (p / "task.json").is_file()))
    return task_dirs


def cmd_audit(args: argparse.Namespace) -> int:
    task_dirs = _iter_task_dirs(args.task_dirs)
    if not task_dirs:
        print("no task dirs found", file=sys.stderr)
        return 1
    results = [
        audit_task(load_task(task_dir), Path(args.results), args.models)
        for task_dir in task_dirs
    ]
    if args.json:
        print(json.dumps([r.as_dict() for r in results], indent=2))
    else:
        print(format_audit_markdown(results, args.models))
    return 1 if args.strict and any(r.verdict != "accepted" for r in results) else 0


def main() -> None:
    parser = argparse.ArgumentParser(prog="mysb", description="make your own swe-bench")
    sub = parser.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("task_dir", help="task directory containing task.json")
    common.add_argument("--repo", required=True, help="path to a local clone containing base_commit")
    common.add_argument("--results", default="results", help="results root dir (default: results)")
    common.add_argument("--quiet", action="store_true", help="don't stream sandbox output")

    p_val = sub.add_parser("validate", parents=[common], help="gold-validate a task (must pass before the task counts)")
    p_val.set_defaults(fn=cmd_validate)

    p_run = sub.add_parser("run", parents=[common], help="run one agent rollout against a task")
    p_run.add_argument("--provider", required=True, help="pi provider, e.g. openai|fireworks")
    p_run.add_argument("--model", required=True, help="pi model id, e.g. gpt-5.5")
    p_run.add_argument("--thinking", default=None, help="pi thinking level: off|minimal|low|medium|high")
    p_run.set_defaults(fn=cmd_run)

    p_rep = sub.add_parser("report", help="print a markdown resolved-rate table from results")
    p_rep.add_argument("results", nargs="?", default="results")
    p_rep.add_argument("--models", nargs="+", help="optional result subdirs to include")
    p_rep.add_argument("--tasks", nargs="+", default=["tasks"], help="task dirs used for verdict filtering")
    p_rep.add_argument(
        "--verdict",
        nargs="+",
        choices=("accepted", "needs_review", "rejected"),
        help="only include tasks whose audit verdict matches",
    )
    p_rep.set_defaults(fn=cmd_report)

    p_audit = sub.add_parser("audit", help="audit task quality and solver signal")
    p_audit.add_argument("task_dirs", nargs="+", help="task dir(s), or parent dirs containing task dirs")
    p_audit.add_argument("--results", default="results", help="results root dir (default: results)")
    p_audit.add_argument(
        "--models",
        nargs="+",
        default=list(DEFAULT_SIGNAL_MODELS),
        help="result subdirs used as the solver-signal ladder",
    )
    p_audit.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    p_audit.add_argument("--strict", action="store_true", help="exit nonzero unless every task is accepted")
    p_audit.set_defaults(fn=cmd_audit)

    p_review = sub.add_parser("review", help="serve a local task review website")
    p_review.add_argument("--tasks", default="tasks", help="task dir or parent task root (default: tasks)")
    p_review.add_argument("--results", default="results", help="results root dir (default: results)")
    p_review.add_argument(
        "--models",
        nargs="+",
        default=list(DEFAULT_SIGNAL_MODELS),
        help="result subdirs used as the solver-signal ladder",
    )
    p_review.add_argument("--host", default="127.0.0.1", help="bind host (default: 127.0.0.1)")
    p_review.add_argument("--port", type=int, default=8765, help="bind port (default: 8765)")
    p_review.set_defaults(fn=cmd_review)

    args = parser.parse_args()
    sys.exit(args.fn(args))
