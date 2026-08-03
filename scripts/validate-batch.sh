#!/usr/bin/env bash
# validate-batch.sh — validate all selfbench tasks concurrently on Harbor.
#
# Defaults to the Modal environment so the whole public task set can fan out
# without contending for a single local Docker daemon. Set SELFBENCH_ENV
# (or pass --env) to override, e.g. SELFBENCH_ENV=docker for offline debugging.
#
# Concurrency defaults to the number of tasks (run everything at once on
# Modal). Set SELFBENCH_CONCURRENCY to throttle, e.g. SELFBENCH_CONCURRENCY=4.
#
# Idempotent: tasks that already have a current, valid validation result are
# skipped. Per-task results and per-task logs are preserved.
#
# Usage (run from the selfbench repo root):
#   scripts/validate-batch.sh <tasks-root> \
#       --repos-root <repos-root> \
#       [--results <results>] [--jobs <harbor-jobs>] \
#       [--harbor-tasks <harbor-tasks>] [--logs <logs>] \
#       [--env <env>] [--concurrency <n>] [--repo-map REPO=PATH ...]
#
# Environment overrides:
#   SELFBENCH_ENV                        Harbor environment (default: modal)
#   SELFBENCH_CONCURRENCY                tasks to validate concurrently (default: all)
#   SELFBENCH_VALIDATION_ENV             same as SELFBENCH_ENV
#   SELFBENCH_VALIDATION_CONCURRENCY     same as SELFBENCH_CONCURRENCY
set -uo pipefail

args=(validate-batch)
if [ -n "${SELFBENCH_CONCURRENCY:-${SELFBENCH_VALIDATION_CONCURRENCY:-}}" ]; then
  args+=(--concurrency "${SELFBENCH_CONCURRENCY:-${SELFBENCH_VALIDATION_CONCURRENCY}}")
fi
if [ -n "${SELFBENCH_ENV:-${SELFBENCH_VALIDATION_ENV:-}}" ]; then
  args+=(--env "${SELFBENCH_ENV:-${SELFBENCH_VALIDATION_ENV}}")
fi
# Forward caller-provided flags and the positional task dirs so this wrapper
# stays a thin pass-through to `selfbench validate-batch`.
args+=("$@")

exec uv run selfbench "${args[@]}"
