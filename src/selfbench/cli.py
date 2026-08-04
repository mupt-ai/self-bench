"""selfbench CLI: create, validate, audit, and review Harbor evals."""

from __future__ import annotations

import argparse
import json
import shlex
import sys
from pathlib import Path

from .create import launch_create_agent
from .harbor import build_harbor_task
from .prompt_generation import generate_prompt, save_generated_prompt
from .quality import audit_task, format_audit_markdown
from .review import cmd_review
from .runner import save_result, validate_task
from .task import load_task


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _harbor_run_command(task_dir: Path) -> str:
    return shlex.join(
        [
            "uv",
            "run",
            "harbor",
            "run",
            "--path",
            str(task_dir),
            "--agent",
            "selfbench.harbor_pi:SelfbenchPi",
            "--model",
            "openai/gpt-4.1",
            "--jobs-dir",
            "harbor-jobs",
        ]
    )


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
    print(f"Run with Harbor: {_harbor_run_command(path)}")
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    task_dirs = _iter_task_dirs(args.task_dirs)
    if not task_dirs:
        print("no task dirs found", file=sys.stderr)
        return 1

    summaries: list[dict[str, object]] = []
    for task_dir in task_dirs:
        task = load_task(task_dir)
        result = validate_task(
            task,
            Path(args.repo).resolve(),
            harbor_root=Path(args.harbor_tasks),
            jobs_root=Path(args.jobs),
            environment=args.env,
            rebuild=args.rebuild,
            verbose=not args.quiet and not args.json,
        )
        result_path = save_result(result, Path(args.results), "validation")
        summaries.append(
            {
                "task_id": result["task_id"],
                "valid": result["valid"],
                "checks": result["checks"],
                "duration_s": result["duration_s"],
                "harbor_task": result["harbor"]["task_dir"],
                "result": str(result_path),
            }
        )

    if args.json:
        print(json.dumps(summaries, indent=2))
    else:
        for summary in summaries:
            status = "PASS" if summary["valid"] else "FAIL"
            print(f"{status} {summary['task_id']} ({summary['duration_s']}s)")
            print(f"  Harbor task: {summary['harbor_task']}")
            print(f"  Result: {summary['result']}")
            if summary["valid"]:
                print(f"  Run: {_harbor_run_command(Path(str(summary['harbor_task'])))}")
        valid_count = sum(1 for summary in summaries if summary["valid"])
        print(f"{valid_count}/{len(summaries)} evals valid")
    return 0 if all(summary["valid"] for summary in summaries) else 1


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


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="selfbench",
        description="create private software-engineering evals for Harbor",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "task_dirs",
        nargs="+",
        help="task dir(s), or parent dirs containing task dirs",
    )
    common.add_argument("--repo", required=True, help="path to a local clone containing base_commit")
    common.add_argument("--results", default="results", help="lightweight result index (default: results)")
    common.add_argument("--harbor-tasks", default="harbor-tasks", help="compiled Harbor task root")
    common.add_argument("--jobs", default="harbor-jobs", help="canonical Harbor jobs root")
    common.add_argument("--env", default="docker", help="Harbor environment provider (default: docker)")
    common.add_argument("--rebuild", action="store_true", help="rebuild the compiled Harbor task")
    common.add_argument("--quiet", action="store_true", help="suppress per-trial Harbor progress")
    common.add_argument("--json", action="store_true", help="emit machine-readable JSON")

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

    p_audit = sub.add_parser("audit", help="audit task quality")
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

    args = parser.parse_args()
    sys.exit(args.fn(args))
