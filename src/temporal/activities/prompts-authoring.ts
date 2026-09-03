import {
  AUTHOR_VERIFY_BUDGET,
  type Candidate,
  MAX_AUTHORING_ROUNDS,
  type RunRequest,
} from "../../contracts.js";

const tierRequirements = {
  easy: "at least 20 changed implementation lines across at least 1 implementation file, at least 1 fail-to-pass test, and no pass-to-pass minimum",
  medium:
    "at least 50 changed implementation lines across at least 2 implementation files, at least 1 fail-to-pass test, and at least 1 pass-to-pass test",
  hard: "at least 100 changed implementation lines across at least 3 implementation files, at least 1 fail-to-pass test, and at least 2 pass-to-pass tests",
} as const;

/** Round 1 prompt: the complete Harbor task (definition, environment contract, patches). */
export function authoringPrompt(run: RunRequest, candidate: Candidate): string {
  return `Author exactly one ${candidate.difficulty} SelfBench task for this assigned candidate:

${JSON.stringify(
  {
    sourcePr: candidate.sourcePr,
    sourceUrl: candidate.sourceUrl,
    baseCommit: candidate.baseCommit,
    completedCommit: candidate.completedCommit,
    request: candidate.request,
  },
  null,
  2,
)}

Use only this candidate. Do not discover alternatives and do not run Harbor. Read /work/provenance.json only to verify the supplied authentic request. Inspect the base and completed commits. Split the completed change into a non-test gold patch and a held-out test patch. The task must meet ${candidate.difficulty} mode: ${tierRequirements[candidate.difficulty]}.

# Held-out tests

Held-out tests must verify public behavior through an existing API, command, persistence boundary, or extension seam. When the request is about an endpoint/provider contract, exercise that boundary instead of manually composing internal translators, context/option builders, or model factories. Do not import gold-specific private helpers/modules or assert exact internal SQL, query counts, schema/index names, object identity, telemetry layout, error wording, endpoint/response shapes, or UI copy/order unless the authentic request explicitly makes that artifact public. Assert requested semantic values rather than larger retained/raw payloads that happen to contain them, and preserve valid adjacent input content unless the request says to discard it. Cover every material behavior in the prompt, including central authorization, error, and UI states. A different correct implementation with different helpers, file boundaries, API presentation, and UI composition must be able to pass; reject the candidate when no stable public seam exists.

# Environment contract

Your submission carries the complete environment contract; there is no separate environment agent. Work only at the currently checked-out pinned base commit. Inspect the test paths and test command, then identify the closest repository-native CI job that runs them. Inspect relevant .github/workflows files, Dockerfiles, devcontainers, lockfiles, version files, package scripts, Makefiles, and compose files. Prefer an image already used by CI or the repository, followed by a devcontainer, then an explicit translation of CI setup. Do not infer from the latest remote branch.

The environment contract must be complete:
- baseImage must be a Linux image pinned with @sha256; use skopeo inspect docker://IMAGE to resolve registry digests rather than inventing one;
- rootSetupCommand runs as root under /bin/sh and must install the exact repository runtimes, package managers, native dependencies, and SelfBench substrate required by the chosen base image: bash, git, procps/pkill, runuser, tar, and useradd;
- setupCommand runs from the task workdir under bash and must perform the frozen dependency install plus required builds, code generation, fixtures, browser installation, or other CI setup;
- smokeCommand runs at runtime from the task workdir as the verifier user (HOME=/home/verifier) and must cheaply prove the runtime and service contract without depending on the hidden gold patch or new held-out tests. It must print what it checks; a silent failure returns nothing you can act on;
- environmentVariables must contain only non-secret literal values needed by tests. A secret-named variable (TOKEN, SECRET, API_KEY, PASSWORD, ...) is accepted only with a fixed placeholder literal such as "test" or "selfbench-local-secret"; values shaped like real key material or interpolating host variables are rejected;
- services must represent only services needed by the focused tests, use registry digests resolved with skopeo, provide health checks, and contain no external secrets; local throwaway service passwords are allowed only inside the service definition;
- evidence must cite repository-relative files that exist at this exact commit and explain what each established.

Never copy CI secrets, deployment steps, caches, artifact uploads, hosted runner credentials, or mutable image tags. Do not use Docker-in-Docker. Do not add fallback dependencies merely because a language ecosystem might need them: every runtime and system package must be justified by the selected CI/test path. If repository evidence is incomplete, use source "generated" but still cite the nearest manifests and scripts.

Use bash/read/grep/find to inspect and, when feasible, execute exploratory setup or focused smoke commands in this sandbox. These exploratory checks are evidence for reasoning only; the worker's compile, audit, build, smoke, nop, and oracle gates are authoritative.

# Deliverable

Your deliverable is the directory /work/task/ with exactly four files, written with read/write/bash and git diff:
- definition.json: the task definition (schemaVersion 2, difficulty "${candidate.difficulty}") including the environment contract; omit prompt or keep it identical to instruction.md;
- instruction.md: the standalone instruction the evaluated agent reads (it is authoritative for the prompt);
- test.patch: the held-out test patch (a Git patch starting with diff --git, LF line endings, final newline; produce it with git diff);
- gold.patch: the non-test reference implementation patch, same format.
Both patches must apply cleanly to the base commit with git apply, and gold.patch must also apply on top of test.patch (the oracle order); verify proves this against a clean worktree before anything is built.
The verify and submit_task tools take no arguments; they read /work/task/ and report missing or malformed files as static-check errors naming the file. The trusted compiler renders task.toml, both Dockerfiles, the scripts, and the repository snapshot; never write those yourself.

# Submission and rounds

Call submit_task exactly once per round, normally after verify is green. If no verify calls remain, still submit your best deliverable: the worker verifies it itself, and a red result starts the next round with the report instead of ending the task. Never end a round without submitting when /work/task/ holds a deliverable you believe is correct. definition.json must use schemaVersion 2 and difficulty "${candidate.difficulty}". testCommand must contain the literal {tests} exactly once as an unquoted shell argument list, and every selected test path must be supplied only through that placeholder—never quote the whole placeholder, assign it to one scalar, or hard-code a fail-to-pass or pass-to-pass path elsewhere in the command. Use one repository-native test mode and bundler per command rather than chaining equivalent suites or bypassing repository wrappers with a generic runner. The prompt must not mention the PR, commits, patches, test names, or implementation. Inspect repository test scripts and CI only to select the correct test command. Do not move dependency installation, native builds, fixture generation, or browser installation into testCommand; the environment contract owns those.

Before submission, verify from repository scripts and the pinned diff that the selected test identifiers belong to one repository-native test command and form the required nop/oracle split: on the base snapshot plus held-out tests, failToPass must fail while passToPass succeeds; with the gold patch applied, both must pass deterministically. Do not invent a test command when no stable test seam exists. Default resources are 4 CPU, 8192 MB memory, 20480 MB storage; default timeouts are 900 setup, 2400 agent, 900 tests.

# Verify before you submit

Write the deliverable to /work/task/, then call verify (no arguments) before you submit. It runs the static check, then the worker renders task.toml, both Dockerfiles, and the scripts from your contract, audits the patches, builds the image, and runs smoke, nop, and oracle exactly as the harness does, and returns the report (this can take up to an hour; wait for it). Fix the red gates and call verify again; you have ${AUTHOR_VERIFY_BUDGET} verify calls in this session and each result states how many remain. The gate-to-field mapping in the skill tells you which field a red gate points at. Call submit_task (no arguments) once verify is green, with the deliverable files unchanged since that verify so the worker can reuse the report. When the budget is exhausted before a green report, submit anyway rather than explaining; the worker's own verification decides, and a failing submission continues into the next round with the report. The only reason not to submit is a failure you cannot fix within the rules (for example no stable test seam exists); then explain why in your final message. If verify itself errors on the worker, the call is not charged; retry it. If your sandbox dies mid-session you may be resumed in a fresh sandbox with the last report (at most ${MAX_AUTHORING_ROUNDS} rounds in total). Do not return prose after a tool call.

Pinned SelfBench version: ${run.version.selfbenchCommit}.`;
}

/** Prompt appended as the next user turn when an authoring session is resumed. */
export function authoringResumePrompt(round: number, renderedReport: string): string {
  return `Round ${round} of ${MAX_AUTHORING_ROUNDS}. Your previous submission did not pass verification. This is a fresh sandbox: the repository was re-cloned at the pinned base commit, your earlier working-tree edits are gone, and only this conversation carries over. Read the report, rewrite the deliverable in /work/task/ (definition.json with the environment contract, instruction.md, test.patch, gold.patch), call verify until it is green (the result states how many verify calls remain), then call submit_task exactly once. Every rule from the original brief still applies; do not weaken tests or move setup into the test command merely to turn a gate green. If the failure cannot be fixed within those rules, do not submit and explain why in your final message.

${renderedReport.trim()}`;
}
