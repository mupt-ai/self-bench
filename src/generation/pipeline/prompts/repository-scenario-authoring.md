# Build One Eval Task from a Scenario in This Repository

A person described a change they want made in this repository, or a situation an agent working in it should handle. You are turning it into a benchmark task. Later, a coding agent gets the repository at the base commit plus a written instruction, and hidden tests decide whether its change is correct. No merged pull request stands behind it: you write the instruction, the reference implementation, and the hidden tests, and prove they work with the verify tool.

## Scenario

- Title: {{title}}
- Base commit: {{baseCommit}} (cloned at /work/repo)
- Requested difficulty: {{difficulty}}

<scenario>
{{request}}
</scenario>

{{attachments}}

/work/provenance.json holds the original request record; use it only to confirm the scenario.

{{maintainer}}

# What to Produce

Six files in /work/task/:

- instruction.md: the instruction the coding agent reads.
- gold.patch: the reference implementation, no tests.
- test.patch: the hidden tests.
- Dockerfile: the environment the agent works and the tests run in.
- smoke.sh: proves the environment is ready for the agent.
- run-tests.sh: runs the hidden tests.
- services.sh, only if the tests need a service such as a database: starts it.

Make both patches with `git diff` against the base commit; test.patch must apply first and gold.patch on top of it. Skip paths the repository marks `export-ignore` in .gitattributes: the agent's snapshot is a `git archive` and will not contain them.

# Make the Scenario a Task

- Find what the scenario asks for: the change a careful engineer would make here, and the mistakes it warns against. The task must reward exactly that.
- Build it on this repository as it is: its conventions, frameworks, and versions at the base commit. Write gold.patch the way a maintainer would, through the code the change belongs in.
- The requested difficulty is a guide, not a check: easy is a contained change in one place; medium touches a few files or reconciles existing behavior; hard is a multi-file change across layers or a migration with traps.
- If the scenario depends on something this repository doesn't have (a framework version, a service, a feature flag), set it up in the Dockerfile only when the scenario says so; otherwise build the task on what is there and say nothing the repository contradicts.

# Isolate the Tests

- gold.patch and test.patch touch different files. Fail-to-pass tests fail on the base, pass with gold, every time.
- The agent's changes to any file test.patch touches are discarded before grading.
- Test through a public boundary: an HTTP response, a command's output, a rendered page, a persisted record. Don't import private helpers from the gold patch, and don't pin SQL, error wording, UI copy, or response shapes the scenario doesn't ask for. A different correct implementation must pass.
- Unless the instruction asks for them, don't pin: exact call counts or request order; one spelling of an equivalent; a type a test needs to compile; one mechanism among several correct ones; text checks loose enough to match harmless prose; hidden limits on length, size, or time; mocks that refuse requests another correct approach makes; an answer to a policy choice the instruction leaves open. Assert the behavior instead.
- When the scenario names a mistake (for example, leaking one user's data to another, or a stale value after a write), write a test that fails on that mistake and passes on the correct behavior.
- Pin existing text or behavior only when the instruction implies the solution goes through that existing path.

# Keep the Instruction Fair

- Write it as the person would ask, from the scenario: what they want, not how to build it. Don't name the trap or the API that avoids it unless the scenario does.
- If the tests depend on a specific name, path, route, or interface, the instruction must state it.

# Environment

The Dockerfile's build context holds only `repo.tar.gz`, the base commit's files without Git history. Unpack it into /app with `ADD repo.tar.gz /app/`, then install and build what the repository needs. SelfBench builds the agent's image and the separate verifier's image from your Dockerfile, so both start from the same /app.

- Derive it from the repository's CI, Dockerfiles, devcontainer, and lockfiles. Only literal, non-secret values.
- Name base images by tag (`node:22-bookworm`); the worker pins each tag to its current digest. Add `@sha256:` only when the repository itself pins that digest, copied exactly. Never write a digest yourself. `skopeo inspect docker://IMAGE` confirms a tag exists.
- The image needs bash, git, pkill (procps), runuser and useradd (passwd), and tar. Leave /app without a .git directory.
- The agent works in its image as root, with the HOME and caches the Dockerfile left, and its network is limited to its model provider. Install everything the agent and the tests need ahead of time, including dependencies gold.patch adds: nothing reinstalls after a solution is applied.
- smoke.sh runs in /app under exactly the agent's conditions. Exercise the tools the agent needs to run the tests, not just the base image.
- run-tests.sh runs in /app as an unprivileged user, over the agent's changes with test.patch applied. Its one argument is `fail-to-pass` (the tests the scenario adds) or `pass-to-pass` (existing tests around the change, which pass before and after it), and it exits 0 only when every one of those tests passes. It rebuilds changed source if the tests need that.
- Services run in the image, not beside it. Install and initialize them in the Dockerfile; services.sh runs as root from /app before the agent's changes are applied, starts each in the background, waits until it is ready, and exits 0. The agent's image has it at /opt/selfbench-environment/services.sh: smoke.sh runs it first, and instruction.md tells the agent it starts the services.
- Every task gets {{limits}}.

{{howToWork}}
{{feedback}}
