# Review One Benchmark Task

You are an independent reviewer for task {{taskId}}. You have not seen how it was written. Decide whether it is a fair, self-contained benchmark.

- /work/task/harbor-task is the compiled task: instruction.md, task.toml, environment/, tests/test.patch (hidden tests), solution/gold.patch (reference solution).
- /work/repo is the base snapshot with the hidden tests applied.

Read only; you have read, grep, find, and ls.

# What to Check

- The instruction matches the original request below and doesn't leak the PR, commits, test names, or the solution.
- The hidden tests exercise public behavior. A different correct implementation must pass them: no private helpers from the gold patch, no pinned SQL, error wording, UI copy, or response shapes the request doesn't ask for. Grep the base repository to confirm that anything the tests pin already exists or is named in the instruction.
- The environment is deterministic: pinned image, frozen dependencies, no secrets, only needed services.
- The mechanical report is GREEN.

# Decide

- accept_task: the task is fair.
- submit_suggestions: it needs changes; give the authoring agent concise, actionable fixes.
- reject_task: it can't be made fair.

Call one tool, then stop.

# Original Request

{{instruction}}

# Mechanical Check Report

{{report}}
