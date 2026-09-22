/** Prompt sections are kept separately so policy changes are reviewable without parsing one giant template. */
export const AUTHORING_TEST_EVIDENCE = `# Test Reuse and Evidence

Keep ownership of tests and complete setup in this session; do not create a separate environment stage. First inspect tests added or changed by the PR and existing regression coverage. Reuse suitable public-behavior assertions and author only missing coverage. Record definition.testSelection with mode (reused, augmented, authored, or base-only), reused/added/excluded arrays identifying tests and reasons, and coverage explaining how tests cover the request. Existing tests still require fairness review. Do not invent test edits merely to produce a patch. For base-only mode, test.patch must be empty, reused must be nonempty, and added empty; base tests remain visible to the solver.

When the runner supports JUnit XML, use definition.testResults = {format: "junit", failToPass: ["classname::name"], passToPass: [...]}. These are exact XML testcase identities, separate from command selectors. Configure testCommand to write a fresh report to "$SELFBENCH_JUNIT_REPORT" on every invocation, including failures, and install python3 in rootSetupCommand. JUnit mode requires every declared target to assertion-fail on the base and pass with the reference; skipped, missing, duplicate, and errored results fail closed. If a missing public API makes collection fail, prefer a public-boundary assertion or explicitly retain command-level mode and explain the limitation in coverage. Never rewrite a runner failure into a fake passing report.`;

export const HELD_OUT_TESTS = `# Held-Out Tests

Held-out tests must verify public behavior through an existing API, command, persistence boundary, or extension seam. Do not import gold-specific private helpers or assert exact internal SQL, query counts, schema/index names, object identity, telemetry layout, incidental error wording, endpoint/response shapes, or UI copy/order unless the authentic request explicitly makes that artifact public. Assert requested semantic values rather than larger retained/raw payloads that happen to contain them, and preserve valid adjacent input content unless the request says to discard it. Cover every material behavior in the prompt, including authorization, error, and UI states. A different correct implementation with different helpers, file boundaries, API presentation, and UI composition must be able to pass.`;

export const ENVIRONMENT_CONTRACT = `# Environment Contract

Your submission carries the complete environment contract; there is no separate environment agent. Work only at the pinned base commit. Inspect test paths and the test command, then identify the closest repository-native CI job. The environment contract must be deterministic and reproducible:

- Use a Linux base image pinned with @sha256.
- Install exact runtimes, package managers, native dependencies, and SelfBench substrate required by the selected path.
- Run frozen dependency installation and required builds, code generation, fixtures, browser installation, or other CI setup in setupCommand.
- Make smokeCommand cheaply prove the runtime and service contract without hidden gold tests; print what it checks.
- Include only literal, non-secret environment values. Use fixed placeholders for secret-named variables.
- Define only services needed by focused tests, with pinned images and health checks.
- Do not copy CI secrets, deployment steps, caches, hosted credentials, or use Docker-in-Docker.

Cite repository-relative evidence for every contract choice. Exploratory checks inform reasoning; the worker's compile, audit, build, smoke, nop, and oracle gates are authoritative.`;

export const DELIVERABLE = `# Deliverable

Write exactly four files to /work/task/: definition.json, instruction.md, test.patch, and gold.patch. definition.json uses schemaVersion 2 and the honest difficulty tier. Both patches must apply cleanly to the pinned base commit; gold.patch must apply after test.patch. The verify and submit_task tools read these files and take no arguments. Never write rendered task.toml, Dockerfiles, or scripts yourself.`;

export const SUBMISSION = `# Submission and Rounds

Call submit_task exactly once per round, normally after verify is green. If the budget is exhausted, submit your best deliverable rather than ending the round without a submission. The prompt must not mention PRs, commits, patches, test names, or implementation. Use one repository-native test mode and bundler; do not move setup into testCommand. If the failure cannot be fixed within the rules, explain why instead of submitting an unfair task.`;

export const VERIFY = `# Verify Before You Submit

Write the deliverable, then call verify with no arguments. It runs static checks, renders the task, audits patches, builds the image, and runs smoke, nop, and oracle. Fix red gates and retry while calls remain. Call submit_task once the deliverable is ready and stop after the tool call. If verify itself errors, retry; a worker error is not a charged verification result.`;

export function joinPromptSections(...sections: (string | false | undefined)[]): string {
  return sections.filter((section): section is string => Boolean(section)).join("\n\n");
}
