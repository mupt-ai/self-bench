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

# What to Produce

Four files in /work/task/:

- gold.patch: the implementation, no tests.
- test.patch: the hidden tests. Reuse the PR's tests when they are fair; add only what is missing.
- instruction.md: the instruction the coding agent reads.
- definition.json: the shape below. Omit `prompt`; it comes from instruction.md.

Make both patches with `git diff` against the base commit; test.patch must apply first and gold.patch on top of it. Skip paths the repository marks `export-ignore` in .gitattributes: the agent's snapshot is a `git archive` and will not contain them.

```json
{
  "schemaVersion": 2,
  "difficulty": "medium",
  "taskId": "project-pr-123",
  "repo": "owner/project",
  "baseCommit": "<40-char base commit>",
  "sourcePr": 123,
  "sourceUrl": "https://github.com/owner/project/pull/123",
  "workdir": ".",
  "testCommand": "bun test {tests}",
  "failToPass": ["tests/new-behavior.test.ts"],
  "passToPass": ["tests/existing.test.ts"],
  "testPaths": ["tests/new-behavior.test.ts"],
  "testSelection": {
    "mode": "reused",
    "reused": ["<test and why>"],
    "added": [],
    "excluded": [],
    "coverage": "How the tests cover the request."
  },
  "timeouts": { "setupSeconds": 900, "agentSeconds": 2400, "testsSeconds": 900 },
  "resources": { "cpus": 4, "memoryMb": 8192, "storageMb": 20480 },
  "environment": {
    "schemaVersion": 1,
    "baseImage": "node:22-bookworm@sha256:<digest>",
    "rootSetupCommand": "apt-get update && apt-get install -y --no-install-recommends bash git",
    "setupCommand": "bun install --frozen-lockfile",
    "smokeCommand": "bun --version",
    "environmentVariables": { "CI": "1" },
    "services": [],
    "source": "ci-adapted",
    "evidence": [{ "path": ".github/workflows/ci.yml", "reason": "Defines the test job." }]
  }
}
```

`testCommand` contains `{tests}` exactly once; failToPass and passToPass are the selectors it receives. Paths are repository-relative. testSelection.mode is reused, augmented, or authored. For exact per-test results, add `"testResults": {"format": "junit", "failToPass": ["classname::name"], "passToPass": [...]}`, write the report to "$SELFBENCH_JUNIT_REPORT" on every run, and install python3 in rootSetupCommand.

# Isolate the Tests

- gold.patch and test.patch touch different files. Fail-to-pass tests fail on the base, pass with gold, every time.
- Test through a public boundary. Don't import private helpers from the gold patch, and don't pin SQL, error wording, UI copy, or response shapes the request doesn't ask for. A different correct implementation must pass.
- Backend + frontend change: test the backend contract, not a mocked frontend.

# Keep the Instruction Fair

- Write it as the engineer asking, from the original request; keep everything the tests check.
- No PR, commits, test names, or implementation details.
- If the tests depend on a specific name or interface, the instruction must state it.

# Environment

- Derive it from the repository's CI: an @sha256-pinned image, a setupCommand that installs and builds, and a smokeCommand that prints what it checks. Only literal, non-secret environment values.
- The harness applies the patch and then runs only testCommand. If the tests need a rebuild of the changed source, testCommand must do that build.

# Difficulty

Keep or lower the tier, never raise it. {{tiers}}. verify enforces these.

{{howToWork}}
{{feedback}}
