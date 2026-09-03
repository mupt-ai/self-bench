# Task construction and validation

SelfBench creates easy, medium, and hard Harbor evaluations from completed pull requests. This document defines the task boundary, the authoring and verification rounds, and export contents.

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

Every accepted task also requires a held-out test patch with no file overlap with the reference patch, deterministic repository-native setup and tests, a passing smoke/nop/oracle split, and acceptance by the independent verification agent.

The size gate is mechanical. Generated or vendored code suitability remains a verification judgment. Git LFS, submodules, generated changes, and service-heavy integration suites receive no special path and may be rejected during authoring or verification.

## Agent-visible boundary

An evaluated coding agent receives:

- the base repository snapshot;
- a standalone instruction preserving the human request;
- the task's declared environment.

It does not receive the held-out test patch or reference solution. Harbor mounts `solution/` only for the explicit oracle agent.

The agent image commits the tree as it stands after `setup.sh` (the `selfbench-setup` commit) and snapshots that repository state to `/opt/selfbench/base.git`. The agent's diff (`agent.patch`) is therefore taken against the post-setup snapshot: files that setup creates and does not gitignore are never part of the agent's patch and cannot collide with the verifier image, which runs the same setup. The verifier image keeps the base commit as `HEAD`; when the gold patch changes dependency manifests it resets only those manifest paths after its extra setup pass.

Held-out tests must exercise an existing public API, command, persistence boundary, or extension seam. They may not import gold-specific private helpers or prescribe exact internal SQL, query counts, private schemas, object identity, telemetry layout, incidental error wording, or UI composition unless the source request explicitly makes that artifact public.

## Authoring rounds and verification

Every candidate passes through two agent-centred loops. Agents do the authoring and judging; the harness only renders, builds, and measures.

**Authoring rounds.** One authoring agent session owns the complete Harbor task: instruction, definition (test command, fail-to-pass and pass-to-pass selection, timeouts, resources) and the environment contract (base image, root setup, setup, smoke command, environment variables, services, evidence). Before submitting, the agent calls `verify` with the complete task. The tool runs the static check inside the sandbox first (schema, environment policy, patch path safety, audit thresholds, and a dry render of the Harbor tree into `/work/rendered/`) and returns failures immediately. Otherwise it hands the payload to the worker through a sandbox mailbox and blocks while the worker's trusted compiler renders `task.toml`, both Dockerfiles, the scripts, and the repository snapshot, and Harbor builds the images and runs the smoke command, the `nop` split, and the `oracle` split. The structured report (compile, audit, build, smoke, nop, oracle) comes back as the tool result, so the agent iterates inside its own session; it has three `verify` calls per session. `submit_task` runs the static check again and records the task; when its payload equals the last green `verify`, the worker reuses that report instead of rebuilding. Otherwise the worker verifies the submission itself. If the sandbox dies or a submitted task is red, the same agent session is resumed in a fresh sandbox with the report as its next message (fallback loop). Three red rounds reject the candidate with the last report as the reason. A Harbor infrastructure failure counts as a red round with the build log as the report; three consecutive infrastructure rounds mark the candidate `infrastructure_failed` instead.

The mailbox is a directory in the live sandbox: the tool writes `/work/mailbox/requests/<id>.json`, the worker's supervising activity polls it through the provider's live-sandbox exec and file API, archives each verify under `runs/<run>/<stage>/<candidate>/round-<n>/verify-<k>/`, and writes the response the tool is waiting on. Verifier commands run as the `verifier` user with `HOME=/home/verifier`.

The Harbor gates prove:

1. `nop`: the smoke command succeeds in the built image, then selected new tests fail on the base snapshot while selected regressions pass;
2. `oracle`: the reference patch applies and every selected test passes;
3. determinism: the fail-to-pass selection passes a second time with the oracle.

**Verification rounds.** A separate agent session that has not seen the authoring conversation receives the green task (instruction, held-out test patch, gold patch, environment contract, rendered files), the verification report, and the deterministic coupling evidence. It judges whether the task is a fair, self-contained benchmark: tests exercise public behaviour, no test-to-gold coupling, deterministic environment, instruction faithful to the human request. It either accepts or submits a fix. A fix may edit only the held-out tests and the environment contract (plus the test selection, timeouts, and resources that describe them), never the gold patch, the base commit, or the instruction. The verifier has the same in-session `verify` tool (two calls per session) for its fix; `submit_fix` runs the static check before it counts and reuses a matching green verify. Otherwise the worker re-runs compile, audit, and Harbor and resumes the same verifier session with the new report. A task is accepted only when the verifier accepts and the mechanical gates are green; otherwise the candidate is rejected with the verifier's reason after at most three verifier rounds.

Rejected candidates are replaced from the leftover discovery pool until each tier holds the requested number of accepted tasks or the pool is exhausted.

## Reproducible environments

SelfBench does not infer a generic language toolchain. The authoring agent derives the environment contract from the exact pinned base commit: runtime, dependency installation, builds, fixtures, and local services come from the closest matching CI job, repository Dockerfile, devcontainer, lockfiles, and test scripts.

The resulting contract pins the base and service images by digest, records repository-file evidence for each choice, keeps service credentials local and non-secret, and separates verifier-only services from the agent environment. Secret-named variables are accepted only with fixed placeholder literals; values that look like real key material or interpolate host variables are rejected. The declared smoke command runs in the built verifier image before the `nop` split, so an environment defect is reported to the authoring agent as a red smoke or build gate rather than discovered later.

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

The export includes the repository snapshot at each selected base commit, held-out tests, and reference solutions. It excludes Git history, local provenance/session records, and the authoring and verification agent sessions (those stay in the run's artifacts).

The manifest digest detects accidental corruption but is not a signature because it sits inside the same archive. Extract only exports from a trusted SelfBench deployment and store them as private benchmark material.

The complete model-facing authoring and anti-coupling rubric is in [`src/skills/selfbench/SKILL.md`](../src/skills/selfbench/SKILL.md).
