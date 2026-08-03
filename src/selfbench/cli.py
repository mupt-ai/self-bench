"""selfbench CLI: validate tasks, run rollouts, aggregate reports."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

from .create import launch_create_agent
from .harbor import build_harbor_task
from .prompt_generation import generate_prompt, save_generated_prompt
from .quality import audit_task, format_audit_markdown
from .result_schema import RESULT_SCHEMA_VERSION
from .review import cmd_review
from .runner import (
    DEFAULT_ROLLOUT_ENVIRONMENT,
    DEFAULT_VALIDATION_ENVIRONMENT,
    run_task,
    save_result,
    validate_batch,
    validate_task,
)
from .task import Task, load_task


def _model_slug(provider: str, model: str) -> str:
    model_name = model.rsplit("/", 1)[-1]
    for label, value in (("provider", provider), ("model", model_name)):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value):
            raise ValueError(f"{label} must end in a path-safe identifier")
    return f"{provider}__{model_name}"


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def cmd_generate_prompt(args: argparse.Namespace) -> int:
    task = load_task(args.task_dir)
    if task.source_trace is None:
        print(f"task {task.task_id} has no source coding session", file=sys.stderr)
        return 1
    if not args.confirm_source_upload:
        print(
            "refusing to send the private source conversation to a model provider without "
            "--confirm-source-upload",
            file=sys.stderr,
        )
        return 1
    if args.write and (task.dir / "prompt.md").is_file() and not args.force:
        print("prompt.md already exists; pass --force to replace it", file=sys.stderr)
        return 1
    prompt, request_sha256 = generate_prompt(
        task,
        provider=args.provider,
        model=args.model,
        thinking=args.thinking,
    )
    if not args.write:
        print(prompt)
        return 0
    path = save_generated_prompt(
        task,
        prompt,
        provider=args.provider,
        model=args.model,
        request_sha256=request_sha256,
    )
    print(f"generated prompt: {path}")
    return 0


def cmd_build(args: argparse.Namespace) -> int:
    task = load_task(args.task_dir)
    path = build_harbor_task(
        task,
        Path(args.repo),
        Path(args.harbor_tasks),
        org=args.org,
        overwrite=args.force,
    )
    print(f"Harbor task: {path}")
    print(f"Run it directly: uv run harbor run -p {path} -a <agent> -m <provider/model>")
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    task = load_task(args.task_dir)
    result = validate_task(
        task,
        Path(args.repo).resolve(),
        harbor_root=Path(args.harbor_tasks),
        jobs_root=Path(args.jobs),
        environment=args.env or DEFAULT_VALIDATION_ENVIRONMENT,
        rebuild=args.rebuild,
        verbose=not args.quiet,
    )
    path = save_result(result, Path(args.results), "validation")
    print(json.dumps({k: result[k] for k in ("task_id", "valid", "checks", "duration_s")}, indent=2))
    print(f"full result: {path}")
    return 0 if result["valid"] else 1


def _repo_map(values: list[str]) -> dict[str, Path]:
    mapping: dict[str, Path] = {}
    for value in values:
        key, separator, raw_path = value.partition("=")
        if not separator or not key or not raw_path:
            raise ValueError(f"repo mapping must be REPO=PATH, got {value!r}")
        mapping[key] = Path(raw_path).expanduser().resolve()
    return mapping


def cmd_validate_batch(args: argparse.Namespace) -> int:
    task_dirs = _iter_task_dirs(args.task_dirs)
    if not task_dirs:
        print("no task dirs found", file=sys.stderr)
        return 1

    tasks = [load_task(task_dir) for task_dir in task_dirs]
    task_ids = [task.task_id for task in tasks]
    if len(task_ids) != len(set(task_ids)):
        print("duplicate task_id in batch", file=sys.stderr)
        return 1

    try:
        overrides = _repo_map(args.repo_map or [])
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    repos_root = Path(args.repos_root).expanduser().resolve() if args.repos_root else None

    def repo_for(task: Task) -> Path:
        if task.repo in overrides:
            return overrides[task.repo]
        if repos_root is None:
            raise ValueError(
                f"no local repository for {task.repo}; pass --repo-map {task.repo}=PATH "
                "or --repos-root"
            )
        return repos_root / task.repo.rsplit("/", 1)[-1]

    environment = args.env or DEFAULT_VALIDATION_ENVIRONMENT
    concurrency = args.concurrency or len(tasks)
    outcomes = validate_batch(
        tasks,
        repo_for,
        results_root=Path(args.results),
        harbor_root=Path(args.harbor_tasks),
        jobs_root=Path(args.jobs),
        environment=environment,
        concurrency=concurrency,
        rebuild=True,
        log_dir=Path(args.logs),
    )
    summary = {
        "environment": environment,
        "concurrency": concurrency,
        "tasks": len(tasks),
        "outcomes": [outcome.as_dict() for outcome in outcomes],
    }
    print(json.dumps(summary, indent=2))
    return 0 if all(outcome.status in {"valid", "skipped"} for outcome in outcomes) else 1


def cmd_run(args: argparse.Namespace) -> int:
    task = load_task(args.task_dir)
    result = run_task(
        task,
        Path(args.repo).resolve(),
        provider=args.provider,
        model=args.model,
        thinking=args.thinking,
        agent=args.agent,
        harbor_root=Path(args.harbor_tasks),
        jobs_root=Path(args.jobs),
        environment=args.env or DEFAULT_ROLLOUT_ENVIRONMENT,
        rebuild=args.rebuild,
        verbose=not args.quiet,
    )
    path = save_result(result, Path(args.results), _model_slug(args.provider, args.model))
    summary = {
        k: result[k]
        for k in ("run_id", "task_id", "provider", "model", "thinking", "resolved", "failure_reasons",
                  "fail_to_pass_passed", "pass_to_pass_passed", "agent_exit_ok",
                  "agent_patch_applied", "duration_s")
    }
    print(json.dumps(summary, indent=2))
    print(f"full result: {path}")
    return 0 if result["resolved"] else 1


def cmd_report(args: argparse.Namespace) -> int:
    root = Path(args.results)
    tasks_by_id = {
        task.task_id: task
        for task in (load_task(task_dir) for task_dir in _iter_task_dirs(args.tasks))
    }
    allowed_task_ids: set[str] | None = None
    if args.verdict:
        audit_models = args.models or []
        audits = [
            audit_task(task, root, audit_models)
            for task in tasks_by_id.values()
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
        task = tasks_by_id.get(task_id)
        if task is not None and (
            r.get("result_schema_version") != RESULT_SCHEMA_VERSION
            or r.get("task_fingerprints") != task.evaluation_fingerprints
        ):
            status = "stale"
        else:
            status = "pass" if r["resolved"] else "fail"
        rows.setdefault(task_id, {})[run_name] = status
    if not rows:
        print(f"no run results under {root}")
        return 1
    cols = sorted(models)
    icons = {"pass": "✅", "fail": "❌", "stale": "⏳"}
    print("| task | " + " | ".join(cols) + " |")
    print("|---" * (len(cols) + 1) + "|")
    for task_id, per_model in sorted(rows.items()):
        print(
            f"| {task_id} | "
            + " | ".join(icons.get(per_model.get(model, ""), "—") for model in cols)
            + " |"
        )
    totals = [
        f"{sum(1 for row in rows.values() if row.get(model) == 'pass')}/"
        f"{sum(1 for row in rows.values() if row.get(model) in {'pass', 'fail'})}"
        for model in cols
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
        if not path.is_dir():
            continue
        task_dirs.extend(sorted(p for p in path.iterdir() if (p / "task.json").is_file()))
    return task_dirs


def cmd_create(args: argparse.Namespace) -> int:
    """Launch Pi with the selfbench skill to author a task interactively."""
    return launch_create_agent(
        args.request,
        repo=Path(args.repo) if args.repo else Path.cwd(),
        tasks_root=Path(args.tasks_root),
        count=args.count,
        provider=args.provider,
        model=args.model,
        thinking=args.thinking,
        print_mode=args.print_mode,
        pi_executable=args.pi_executable,
    )


def cmd_audit(args: argparse.Namespace) -> int:
    task_dirs = _iter_task_dirs(args.task_dirs)
    if not task_dirs:
        print("no task dirs found", file=sys.stderr)
        return 1
    models = args.models or []
    results = [
        audit_task(load_task(task_dir), Path(args.results), models)
        for task_dir in task_dirs
    ]
    if args.json:
        print(json.dumps([r.as_dict() for r in results], indent=2))
    else:
        print(format_audit_markdown(results, models))
    return 1 if args.strict and any(r.verdict != "accepted" for r in results) else 0


def build_parser() -> argparse.ArgumentParser:
    """Construct the selfbench CLI argument parser."""
    parser = argparse.ArgumentParser(prog="selfbench", description="benchmark coding agents on your own merged PRs")
    sub = parser.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("task_dir", help="task directory containing task.json")
    common.add_argument("--repo", required=True, help="path to a local clone containing base_commit")
    common.add_argument("--results", default="results", help="lightweight result index (default: results)")
    common.add_argument("--harbor-tasks", default="harbor-tasks", help="compiled Harbor task root")
    common.add_argument("--jobs", default="harbor-jobs", help="canonical Harbor jobs root")
    common.add_argument(
        "--env",
        default=None,
        help=(
            "Harbor environment provider; per-command default is modal for validate "
            "and docker for run. Pass docker for local/offline validation."
        ),
    )
    common.add_argument("--rebuild", action="store_true", help="rebuild the compiled Harbor task")
    common.add_argument("--quiet", action="store_true", help="suppress per-trial Harbor progress")

    p_prompt = sub.add_parser(
        "generate-prompt",
        help="generate a standalone user-voice prompt from a private source coding session",
    )
    p_prompt.add_argument("task_dir", help="task directory containing task.json and trace_source")
    p_prompt.add_argument("--provider", required=True, help="pi provider used for prompt generation")
    p_prompt.add_argument("--model", required=True, help="pi model used for prompt generation")
    p_prompt.add_argument("--thinking", default=None, help="pi thinking level")
    p_prompt.add_argument("--write", action="store_true", help="save the generated prompt to prompt.md")
    p_prompt.add_argument("--force", action="store_true", help="replace an existing prompt.md")
    p_prompt.add_argument(
        "--confirm-source-upload",
        action="store_true",
        help="confirm the private source conversation may be sent to the configured provider",
    )
    p_prompt.set_defaults(fn=cmd_generate_prompt)

    p_build = sub.add_parser("build", help="compile an authoring task into a native Harbor task")
    p_build.add_argument("task_dir", help="task directory containing task.json")
    p_build.add_argument("--repo", required=True, help="local Git clone containing base_commit")
    p_build.add_argument("--harbor-tasks", default="harbor-tasks", help="compiled Harbor task root")
    p_build.add_argument("--org", default="selfbench", help="Harbor task package organization")
    p_build.add_argument("--force", action="store_true", help="replace an existing compiled task")
    p_build.set_defaults(fn=cmd_build)

    p_val = sub.add_parser("validate", parents=[common], help="validate with Harbor nop and oracle trials")
    p_val.set_defaults(fn=cmd_validate)

    p_batch = sub.add_parser(
        "validate-batch",
        help="validate many tasks concurrently (default environment: Modal)",
        description=(
            "Validate every task under the given task dirs concurrently on Harbor. "
            "Defaults to the Modal environment so the whole public set can fan out "
            "without a local Docker daemon; pass --env docker to debug offline. "
            "Tasks that already have a current, valid result are skipped (idempotent). "
            "Per-task results and logs are preserved."
        ),
    )
    p_batch.add_argument("task_dirs", nargs="+", help="task dir(s), or parent dirs containing task dirs")
    p_batch.add_argument("--results", default="results", help="results root (default: results)")
    p_batch.add_argument("--harbor-tasks", default="harbor-tasks", help="compiled Harbor task root")
    p_batch.add_argument("--jobs", default="harbor-jobs", help="canonical Harbor jobs root")
    p_batch.add_argument("--logs", default="logs/validate", help="per-task log directory")
    p_batch.add_argument(
        "--env",
        default=os.getenv("SELFBENCH_VALIDATION_ENV", DEFAULT_VALIDATION_ENVIRONMENT),
        help=(
            f"Harbor environment provider (default: {DEFAULT_VALIDATION_ENVIRONMENT}; "
            "use docker for local/offline validation). Also honors SELFBENCH_VALIDATION_ENV."
        ),
    )
    p_batch.add_argument(
        "--concurrency",
        type=_positive_int,
        default=os.getenv("SELFBENCH_VALIDATION_CONCURRENCY"),
        help=(
            "how many tasks to validate at once; defaults to the task count (run all "
            "concurrently). Also honors SELFBENCH_VALIDATION_CONCURRENCY to throttle."
        ),
    )
    p_batch.add_argument(
        "--repo-map",
        action="append",
        metavar="REPO=PATH",
        help=(
            "map a task.json repo (e.g. fastapi/fastapi) to a local clone path; "
            "repeatable. Falls back to --repos-root/<repo name> otherwise."
        ),
    )
    p_batch.add_argument(
        "--repos-root",
        help=(
            "directory of local repo clones, one per task.json repo name "
            "(e.g. --repos-root ~/code/repos resolves fastapi/fastapi to that dir/fastapi)"
        ),
    )
    p_batch.set_defaults(fn=cmd_validate_batch)

    p_run = sub.add_parser("run", parents=[common], help="run one native Harbor agent trial")
    p_run.add_argument("--provider", required=True, help="pi provider, e.g. openai|fireworks")
    p_run.add_argument("--model", required=True, help="pi model id, e.g. gpt-5.5")
    p_run.add_argument("--agent", default="pi", help="Harbor agent (default: pi)")
    p_run.add_argument("--thinking", default=None, help="agent thinking level when supported")
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
        help="optional result subdirs to display as informational solver signal",
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
        help="optional result subdirs to display as informational solver signal",
    )
    p_review.add_argument("--host", default="127.0.0.1", help="bind host (default: 127.0.0.1)")
    p_review.add_argument("--port", type=int, default=8765, help="bind port (default: 8765)")
    p_review.set_defaults(fn=cmd_review)

    p_create = sub.add_parser(
        "create",
        help="discover PR candidates and create tasks using the selfbench skill (launches Pi)",
        description=(
            "Launch Pi with the bundled selfbench task-building skill. Without a request, Pi discovers and "
            "ranks unseen merged pull requests itself. Positional arguments scope or replace that default "
            "request. Runs interactively by default; pass --print for one-shot output."
        ),
    )
    p_create.add_argument(
        "request",
        nargs="*",
        metavar="MESSAGE",
        help="optional prompt to Pi (joined with spaces); omit to discover merged PR candidates automatically",
    )
    p_create.add_argument("--repo", help="source repository path (defaults to cwd)")
    p_create.add_argument("--tasks-root", default="tasks", help="authoring task root (default: tasks)")
    p_create.add_argument(
        "-n",
        "--count",
        type=_positive_int,
        help="target number of complete benchmark tasks to create",
    )
    p_create.add_argument("--provider", help="Pi provider (e.g. openai, anthropic)")
    p_create.add_argument("--model", help="Pi model ID")
    p_create.add_argument("--thinking", help="Pi thinking level (off, minimal, low, medium, high, xhigh, max)")
    p_create.add_argument(
        "--print",
        dest="print_mode",
        action="store_true",
        help="non-interactive mode: process the prompt and exit",
    )
    p_create.add_argument(
        "--pi-executable",
        default="pi",
        help="path to the Pi executable (default: pi)",
    )
    p_create.set_defaults(fn=cmd_create)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    sys.exit(args.fn(args))
