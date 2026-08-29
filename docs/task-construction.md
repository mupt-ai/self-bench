# Task construction and validation

SelfBench creates easy, medium, and hard Harbor evaluations from completed pull requests. This document defines the task boundary, validation gates, repair behavior, and export contents.

## Terms

- A **candidate** is one possible source pull request.
- The **base snapshot** is the repository state before the change.
- The **reference patch** or **gold** is the known-good non-test implementation.
- The **held-out test patch** is grader code hidden from evaluated agents.
- A **fail-to-pass** test fails on the base snapshot and passes after a correct implementation.
- A **pass-to-pass** test already passes at the base and protects existing behavior.
- A Harbor **nop** run applies no solution; an **oracle** run applies the saved reference patch.
- **Test-to-gold coupling** means a test passes only because it knows the saved implementation's private structure rather than the requested behavior.

## Provenance

Each task is grounded in one retained human request. SelfBench prefers exact user messages from local Pi, Claude Code, or Codex sessions associated with the repository or its worktrees. For third-party repositories, an exact GitHub pull-request title and optional body from a non-bot author is also valid.

GitHub records are stored with a distinct `github-pull-request` source type, canonical URL, and PR number. Discovery cannot pair the request from one PR with another PR. A local message may also carry an explicit PR binding supplied through `self-bench associate`; materialization must then reject every unbound local message for that PR, as well as omitting the GitHub title/body fallback. Association manifests contain only message identities and hashes of SelfBench's sanitized, whitespace-normalized content, while the existing provenance artifact retains that exact normalized text for the task. No model creates associations or request text.

A model-authored benchmark instruction may restate the retained request but may not add behavior inferred only from the implementation or tests.

## Difficulty gates

Profiles are eligibility rules, not empirical claims about model success:

| Difficulty | Reference patch | Fail-to-pass | Pass-to-pass |
| --- | --- | --- | --- |
| easy | at least 20 changed lines across 1 implementation path | at least 1 | no minimum |
| medium | at least 50 changed lines across 2 implementation paths | at least 1 | at least 1 |
| hard | at least 100 changed lines across 3 implementation paths | at least 1 | at least 2 |

Every accepted task also requires a held-out test patch with no file overlap with the reference patch, deterministic repository-native setup and tests, a passing nop/oracle split, and independent anti-coupling review.

The size gate is mechanical. Generated or vendored code suitability remains a review judgment. Git LFS, submodules, generated changes, and service-heavy integration suites receive no special path and may be rejected during authoring or validation.

## Agent-visible boundary

An evaluated coding agent receives:

- the base repository snapshot;
- a standalone instruction preserving the human request;
- the task's declared environment.

It does not receive the held-out test patch or reference solution. Harbor mounts `solution/` only for the explicit oracle agent.

Held-out tests must exercise an existing public API, command, persistence boundary, or extension seam. They may not import gold-specific private helpers or prescribe exact internal SQL, query counts, private schemas, object identity, telemetry layout, incidental error wording, or UI composition unless the source request explicitly makes that artifact public.

## Validation and repair

Static audit runs before sandbox validation. Harbor then proves:

1. `nop`: selected new tests fail while selected regressions pass;
2. `oracle`: the reference patch applies and every selected test passes;
3. determinism: the fail-to-pass selection passes a second time with the oracle.

A fresh model session reviews the prompt and tests without inheriting the authoring conversation. When it finds repairable test-to-gold coupling, Temporal schedules one constrained repair in another sandbox. Repair may modify only paths already changed by the held-out test patch. It cannot change the request, base snapshot, or reference implementation.

After repair, the task repeats static audit, nop, oracle, and independent review from the beginning. A second failure rejects the candidate.

## Reproducible environments

SelfBench does not infer a generic language toolchain. After task authoring selects the held-out tests and repository-native test command, a separate environment author inspects the exact pinned base commit. It derives the runtime, dependency installation, builds, fixtures, and local services from the closest matching CI job, repository Dockerfile, devcontainer, lockfiles, and test scripts.

The resulting contract pins the base and service images by digest, records repository-file evidence for each choice, keeps service credentials local and non-secret, and separates verifier-only services from the agent environment. A deterministic Harbor preflight runs both the declared smoke command and the real base-state nop test split before oracle validation. Environment defects may be repaired twice; infrastructure failures remain retryable rather than being rewritten by an agent.

When the reference patch changes a recognized dependency manifest or lockfile, the hidden verifier image repeats setup with the trusted reference state and then resets source files to the base snapshot. This prevents stale base dependencies from invalidating the oracle without exposing the reference patch to the coding-agent environment.

A test selector is one repository-native identifier substituted into the task's `{tests}` command template. For example, `bun test {tests}` may receive one new test path and two existing regression paths. Pytest, Go, Rust, and custom runners use their own selectors.

## Export

The run export is a gzip-compressed tar archive:

```text
manifest.json
tasks/
├── task-one.tar.gz
└── task-two.tar.gz
```

`manifest.json` pins the source repository commit, SelfBench build identity, execution backend, task IDs, and archive SHA-256 values. Each task archive is a native Harbor task:

```text
harbor-task/
├── task.toml
├── instruction.md
├── environment/
├── tests/
└── solution/
```

The export includes the repository snapshot at each selected base commit, held-out tests, and reference solutions. It excludes Git history, local provenance/session records, and author/reviewer transcripts.

The manifest digest detects accidental corruption but is not a signature because it sits inside the same archive. Extract only exports from a trusted SelfBench deployment and store them as private benchmark material.

The complete model-facing authoring and anti-coupling rubric is in [`src/skills/selfbench/SKILL.md`](../src/skills/selfbench/SKILL.md).
