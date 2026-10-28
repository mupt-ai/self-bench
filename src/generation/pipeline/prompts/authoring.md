# Build One Eval Task

You are turning one merged pull request into a benchmark task. Later, a coding agent gets the repository at the base commit plus a written instruction, and hidden tests decide whether its change is correct. You write the instruction, the hidden tests, and the reference solution, and prove they work with the verify tool.

## Candidate

- Pull request: {{sourceUrl}} (sourcePr {{sourcePr}})
- Base commit: {{baseCommit}}
- Completed commit: {{completedCommit}}
- Estimated difficulty: {{difficulty}}

<request>
{{request}}
</request>

/work/provenance.json holds the original request record; use it only to confirm the request.

{{maintainer}}

# What to Produce

Six files in /work/task/:

- instruction.md: the instruction the coding agent reads.
- gold.patch: the implementation, no tests.
- test.patch: the hidden tests. Reuse the PR's tests when they are fair; add only what is missing.
- Dockerfile: the environment the agent works and the tests run in.
- smoke.sh: proves the environment is ready for the agent.
- run-tests.sh: runs the hidden tests.
- services.sh, only if the tests need a service such as a database: starts it.

Make both patches with `git diff` against the base commit; test.patch must apply first and gold.patch on top of it. Skip paths the repository marks `export-ignore` in .gitattributes: the agent's snapshot is a `git archive` and will not contain them.

# Isolate the Tests

- gold.patch and test.patch touch different files. Fail-to-pass tests fail on the base, pass with gold, every time.
- The agent's changes to any file test.patch touches are discarded before grading.
- Test through a public boundary. Don't import private helpers from the gold patch, and don't pin SQL, error wording, UI copy, or response shapes the request doesn't ask for. A different correct implementation must pass.
- Unless the instruction asks for them, don't pin: exact call counts or request order; one spelling of an equivalent (a CSS longhand but not its shorthand); a type a test needs to compile; one mechanism among several correct ones (a guard where try/catch also works); text checks loose enough to match harmless prose; hidden limits on length, size, or time; mocks that refuse requests another correct approach makes; an answer to a policy choice the instruction leaves open. Assert the behavior instead: the command fails and names both flags, not its sentence; capture is no longer held, not how often release was called.
- Pin existing text or behavior only when the instruction implies the solution goes through that existing path. Existing somewhere in the repository is not enough.
- Don't reverse a visible existing test (a throw that now resolves) unless the instruction states the new behavior.
- Backend + frontend change: test the backend contract, not a mocked frontend.

# Keep the Instruction Fair

- Write it as the engineer asking, from the original request; keep everything the tests check.
- No PR, commits, test names, or implementation details.
- If the tests depend on a specific name or interface, the instruction must state it.

# Environment

The Dockerfile's build context holds only `repo.tar.gz`, the base commit's files without Git history. Unpack it into /app with `ADD repo.tar.gz /app/`, then install and build what the repository needs. SelfBench builds the agent's image and the separate verifier's image from your Dockerfile, so both start from the same /app.

- Derive it from the repository's CI, Dockerfiles, devcontainer, and lockfiles. Only literal, non-secret values.
- Name base images by tag (`node:22-bookworm`); the worker pins each tag to its current digest. Add `@sha256:` only when the repository itself pins that digest, copied exactly. Never write a digest yourself. `skopeo inspect docker://IMAGE` confirms a tag exists.
- The image needs bash, git, pkill (procps), runuser and useradd (passwd), and tar. Leave /app without a .git directory.
- The agent works in its image as root, with the HOME and caches the Dockerfile left, and its network is limited to its model provider. Install everything the agent and the tests need ahead of time (package managers, Corepack shims, toolchains, browsers, databases), including dependencies gold.patch adds: nothing reinstalls after a solution is applied.
- smoke.sh runs in /app under exactly the agent's conditions. Exercise the tools the agent needs to run the tests (for example `pnpm --version`), not just the base image.
- run-tests.sh runs in /app as an unprivileged user, over the agent's changes with test.patch applied. Its one argument is `fail-to-pass` (the tests the request adds or changes) or `pass-to-pass` (existing tests around the change, which pass before and after it), and it exits 0 only when every one of those tests passes. It rebuilds changed source if the tests need that.
- Services run in the image, not beside it. Install and initialize them in the Dockerfile (for example `apt-get install postgresql`, then `initdb` and any fixtures as the `postgres` user). services.sh runs as root from /app, before the agent's changes are applied: it starts each service in the background (Postgres through `runuser -u postgres -- pg_ctl`; it refuses to run as root), waits until it accepts connections, and exits 0. The tests reach services on localhost. The agent's image has it at /opt/selfbench-environment/services.sh: smoke.sh runs it first, and instruction.md tells the agent it starts the services.
- Every task gets {{limits}}.

# Difficulty

The task takes the hardest tier gold.patch reaches, up to the estimated difficulty: {{tiers}}. verify blocks a gold.patch below easy.

{{howToWork}}
{{feedback}}
