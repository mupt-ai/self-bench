# Build One Eval Task from a Feature

You are turning one feature of this repository into a benchmark task. The feature did not land in one pull request: the maintainers built it over the merged pull requests below. Later, a coding agent gets the repository from just before the first of them landed, plus a written feature request, and hidden end-to-end tests decide whether the feature it builds works. You write the instruction, the reference implementation, and the hidden tests, and prove they work with the verify tool.

## Feature

- Feature: {{title}}
- Base commit: {{baseCommit}} (cloned at /work/repo; the default branch just before the first PR landed)
- Completed commit: {{completedCommit}} (the default branch once the last PR landed)
- Estimated difficulty: {{difficulty}}

Its pull requests, in merge order, each with the commit it landed as on the default branch:

{{pullRequests}}

<request>
{{request}}
</request>

/work/provenance.json holds the original request record; use it only to confirm the request. `gh pr view <number>` and `gh pr diff <number>` read each PR's discussion and diff, and the full history is in the clone.

{{maintainer}}

# What to Produce

Six files in /work/task/:

- instruction.md: the feature request the coding agent reads.
- gold.patch: the whole feature's implementation against the base commit, no tests.
- test.patch: the hidden end-to-end tests.
- Dockerfile: the environment the agent works and the tests run in.
- smoke.sh: proves the environment is ready for the agent.
- run-tests.sh: runs the hidden tests.
- services.sh, only if the tests need a service such as a database: starts it.

Make both patches with `git diff` against the base commit; test.patch must apply first and gold.patch on top of it. Skip paths the repository marks `export-ignore` in .gitattributes: the agent's snapshot is a `git archive` and will not contain them.

# Build the Reference from the Pull Requests

- Start a branch at the base commit and bring in each PR's landed change in merge order: `git cherry-pick <commit>` for a squash or rebase commit, `git cherry-pick -m 1 <commit>` for a merge commit (or `git diff <commit>^1 <commit> | git apply -3`).
- Other commits landed on the default branch between the PRs. When a PR's change conflicts with code only those commits introduced, resolve the conflict so the feature works on the base: keep the feature's intent and the base's surrounding code. Don't bring unrelated commits in. A conflict in a file the reference leaves out anyway (a test, a snapshot image, a changelog) resolves by dropping it.
- Keep only the feature. Drop tests (they go to test.patch), changelog and docs-only edits, and unrelated drive-by changes a PR happened to carry, when the feature works without them. Keep dependency and lockfile changes the feature needs, and install them in the Dockerfile.
- The result must build and behave as the feature did at the completed commit. gold.patch is `git diff <base> -- <implementation paths>` of that branch.
- If the PRs turn out not to form one coherent feature (they only share a word, or one of them is a revert of another), build the task from the largest coherent subset whose instruction still describes a whole feature, or explain why there is none and stop.

# Test the Feature End to End

The point of this task is the whole feature, not one function: the tests check what a user or caller of the repository gets once the feature exists.

- Drive the feature through the outermost boundary the repository can run inside the container: run its CLI as a subprocess, start its server in the test and make real HTTP requests, render its pages or components through the framework's test utilities, call its public API as a library user would, and read and write a real database when the feature persists data (start it in services.sh).
- Cover the feature's flows, not just its parts: at least one test per capability the instruction asks for, and at least one that goes through several of them together the way a user would (create, then list, then update; configure, then run; enable, then observe the effect).
- Use the repository's own test runner and its integration or end-to-end setup when it runs headless in the container. A browser runner (for example Playwright) is fine when the repository already uses it: install the browsers in the Dockerfile.
- Reuse and extend the PRs' own tests where they are fair and exercise the feature from outside; add what is missing.
- Keep the tests fast enough for {{limits}}. Don't make a production build (`next build`, a bundler, a whole-project type check) a test or a step of run-tests.sh unless the feature is about the build: every check runs it at least three times.
- gold.patch and test.patch touch different files. Fail-to-pass tests fail on the base, pass with gold, every time.
- The agent's changes to any file test.patch touches are discarded before grading.
- A different correct implementation must pass. Test through public boundaries; don't import private helpers from the gold patch, and don't pin SQL, error wording, UI copy, markup structure, or response shapes the instruction doesn't ask for. Unless the instruction asks for them, don't pin: exact call counts or request order; one spelling of an equivalent; a type a test needs to compile; one mechanism among several correct ones; text checks loose enough to match harmless prose; hidden limits on length, size, or time; mocks that refuse requests another correct approach makes; an answer to a policy choice the instruction leaves open. Assert the behavior instead.
- Pin existing text or behavior only when the instruction implies the solution goes through that existing path. Don't reverse a visible existing test unless the instruction states the new behavior.

# Write the Feature Request

- Write instruction.md as the maintainer asking for the whole feature, from the PRs' own descriptions: what it does for its users and how it behaves, including the edge cases the tests check. Not a step-by-step plan.
- No PRs, commits, test names, or implementation details beyond the interface.
- State every interface the tests depend on: command names and flags, routes and their request and response fields, configuration keys, exported names, file formats, UI labels a test finds an element by.

# Environment

The Dockerfile's build context holds only `repo.tar.gz`, the base commit's files without Git history. Unpack it into /app with `ADD repo.tar.gz /app/`, then install and build what the repository needs. SelfBench builds the agent's image and the separate verifier's image from your Dockerfile, so both start from the same /app.

- Derive it from the repository's CI, Dockerfiles, devcontainer, and lockfiles. Only literal, non-secret values.
- Name base images by tag (`node:22-bookworm`); the worker pins each tag to its current digest. Add `@sha256:` only when the repository itself pins that digest, copied exactly. Never write a digest yourself. `skopeo inspect docker://IMAGE` confirms a tag exists.
- The image needs bash, git, pkill (procps), runuser and useradd (passwd), and tar. Leave /app without a .git directory.
- Don't run `chown -R` or `chmod -R` over /app. On a large dependency tree each one copies every file into a layer of its own, which can take minutes and push the build past its limit. Install and build as root; the verifier takes ownership of /app when its tests start.
- The agent works in its image as root, with the HOME and caches the Dockerfile left, and its network is limited to its model provider. Install everything the agent and the tests need ahead of time (package managers, Corepack shims, toolchains, browsers, databases), including dependencies gold.patch adds: nothing reinstalls after a solution is applied.
- smoke.sh runs in /app under exactly the agent's conditions. Exercise the tools the agent needs to run the tests (for example `pnpm --version`), not just the base image.
- run-tests.sh runs in /app as an unprivileged user, over the agent's changes with test.patch applied. Its one argument is `fail-to-pass` (the end-to-end tests of the feature) or `pass-to-pass` (existing tests around the feature, which pass before and after it), and it exits 0 only when every one of those tests passes. It rebuilds changed source if the tests need that.
- Services run in the image, not beside it. Install and initialize them in the Dockerfile (for example `apt-get install postgresql`, then `initdb` and any fixtures as the `postgres` user). services.sh runs as root from /app, before the agent's changes are applied: it starts each service in the background (Postgres through `runuser -u postgres -- pg_ctl`; it refuses to run as root), waits until it accepts connections, and exits 0. The tests reach services on localhost. The agent's image has it at /opt/selfbench-environment/services.sh: smoke.sh runs it first, and instruction.md tells the agent it starts the services.
- Every task gets {{limits}}.

# Difficulty

The task takes the hardest tier gold.patch reaches, up to the estimated difficulty: {{tiers}}. verify blocks a gold.patch below easy.

{{howToWork}}
{{feedback}}
