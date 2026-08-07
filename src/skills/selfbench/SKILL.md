---
name: selfbench
description: Author one private, hard software-engineering benchmark task from an assigned completed pull request. Use when SelfBench supplies a pinned candidate, authentic request provenance, a base commit, and a completed commit and asks for held-out tests plus a reference implementation.
---

# SelfBench Task Authoring

Create exactly one hard Harbor evaluation from the assigned candidate. Do not discover alternative pull requests. Do not run Harbor; centralized validation owns execution.

## Integrity boundary

The coding agent must receive only a history-free base snapshot and the authentic engineering request. Never place any of the following in the prompt:

- pull request numbers or URLs;
- commit hashes or branch names;
- test names, test paths, or test commands;
- implementation details learned from the completed change;
- gold-patch or held-out-test content.

Use the supplied provenance only to preserve the engineer's original intent. Do not reconstruct a request from the pull request, implementation, or tests.

## Hard-mode gate

Reject the candidate instead of weakening it unless all of these are true:

- the gold patch changes at least 100 implementation lines across at least 3 implementation files;
- the change represents one coherent behavioral requirement;
- tests can be held out without removing implementation files needed by the solver;
- at least one fail-to-pass test fails on the base and passes on the completed change;
- at least two focused pass-to-pass tests protect existing behavior;
- setup and tests are deterministic in a clean checkout;
- no external service, private credential, production resource, or mutable dependency is required;
- the task can be completed within the declared time and resource limits.

SelfBench has no easy mode. Never reduce these thresholds to save a marginal candidate.

## Authoring procedure

1. Verify that the base commit is an ancestor of the completed commit.
2. Inspect the complete diff and repository-native test setup.
3. Classify changed paths as implementation, test, generated, documentation, or unrelated.
4. Build `goldPatch` from only the implementation required for the requested behavior. Exclude tests, generated artifacts, formatting churn, and unrelated cleanup.
5. Build `testPatch` from only held-out behavioral tests and minimal test fixtures. It must not overlap any path in `goldPatch`.
   - Exercise a public API, command, persisted behavior, or existing extension seam. Do not import a
     private helper or new internal module introduced by the gold patch merely because it is easy to
     test directly.
   - Do not require exact helper names, wrapper identity, SQL text/query counts, database index names,
     private telemetry shapes, or internal error wording unless the authentic request makes that exact
     artifact part of the public contract.
   - Do not pin an endpoint path, response field/media type, UI copy, wizard step number/order, markup,
     or presentation format merely because the gold patch chose it. Only assert those details when the
     authentic request explicitly makes them part of the contract.
   - Assert the requested semantic value rather than a larger retained/raw payload that happens to
     contain it. A request for natural-language reasoning, for example, must not require exposing an
     internal machine-readable action alongside it.
   - When the request is about an externally visible endpoint or provider contract, exercise that
     boundary. Do not manually compose internal translators, context builders, option builders, model
     factories, or other pipeline stages to simulate it.
   - Preserve and assert all valid adjacent input content unless the authentic request explicitly says
     it should be discarded. Do not copy a gold adapter's filtering behavior into the expected result.
   - A materially different implementation that satisfies the request must be able to pass. If there is
     no stable public seam for testing the behavior, reject the candidate.
   - Cover every material behavior named in the task prompt, including authorization, error, and UI
     states when those are central. Reject a candidate rather than submitting narrow tests that pin one
     implementation while leaving most of the request unverified.
6. Select exact fail-to-pass and pass-to-pass test identifiers supported by one deterministic test command.
7. Write a standalone prompt in the engineer's voice. Preserve required behavior, constraints, and acceptance criteria without leaking the completed solution.
8. Choose only the toolchains the clean task environment needs.
9. Call `submit_task` exactly once. Do not write an alternate task format.

## Submitted definition

Submit this logical shape through `submit_task`:

```json
{
  "definition": {
    "schemaVersion": 1,
    "difficulty": "hard",
    "taskId": "project-pr-123",
    "repo": "example/project",
    "baseCommit": "0123456789abcdef0123456789abcdef01234567",
    "workdir": ".",
    "setupCommand": "bun install --frozen-lockfile",
    "testCommand": "bun test {tests}",
    "failToPass": ["tests/new-behavior.test.ts"],
    "passToPass": ["tests/existing-a.test.ts", "tests/existing-b.test.ts"],
    "testPaths": ["tests/new-behavior.test.ts"],
    "toolchains": ["node", "bun"],
    "sourcePr": 123,
    "sourceUrl": "https://github.com/example/project/pull/123",
    "prompt": "Implement the requested behavior...",
    "timeouts": {
      "setupSeconds": 900,
      "agentSeconds": 2400,
      "testsSeconds": 900
    },
    "resources": {
      "cpus": 4,
      "memoryMb": 8192,
      "storageMb": 20480
    }
  },
  "testPatch": "diff --git ...",
  "goldPatch": "diff --git ..."
}
```

`testCommand` must contain the literal `{tests}` placeholder. Paths must be repository-relative and must not contain `..`.

## Patch rules

- Produce binary-safe Git patches beginning with `diff --git`.
- Keep test and gold paths disjoint.
- Exclude dependency caches, lockfile churn unrelated to the change, build output, vendored code, and generated files.
- Keep repository-native package-manager pins and frozen install commands.
- Do not patch around a broken base environment. Reject the candidate when reproducibility is not honest.
- Do not include source transcripts or provenance records in either patch.

## Final check

Before submission, re-read the prompt without looking at the completed diff. It must be sufficient to implement the behavior but insufficient to recover the hidden implementation. Confirm the test patch observes public behavior and would fail a plausible wrong implementation, not merely the base commit. Then imagine a second correct implementation with different file boundaries and helper names; the held-out tests must still pass it.
