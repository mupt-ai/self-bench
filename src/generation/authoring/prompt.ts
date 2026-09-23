import { difficultyThresholds } from "../../checks/audit.js";
import {
  AUTHOR_VERIFY_BUDGET,
  type Candidate,
  MAX_AUTHORING_ROUNDS,
} from "../../contracts/index.js";
import { joinPromptSections } from "../agent/prompt-sections.js";

const assignment = (candidate: Candidate): string => `# Build One Eval Task

You are turning one merged pull request into a benchmark task. Later, a coding agent gets the repository at the base commit plus a written instruction, and hidden tests decide whether its change is correct. You write the instruction, the hidden tests, and the reference solution, and prove they work with the verify tool.

## Candidate

- Pull request: ${candidate.sourceUrl} (sourcePr ${candidate.sourcePr})
- Base commit: ${candidate.baseCommit}
- Completed commit: ${candidate.completedCommit}
- Estimated difficulty: ${candidate.difficulty}

<request>
${candidate.request}
</request>

/work/provenance.json holds the original request record; use it only to confirm the request.`;

const deliverable = `# What to Produce

Four files in /work/task/:

- gold.patch: the implementation, no tests.
- test.patch: the hidden tests. Reuse the PR's tests when they are fair; add only what is missing.
- instruction.md: the instruction the coding agent reads.
- definition.json: the shape below. Omit \`prompt\`; it comes from instruction.md.

Make both patches with \`git diff\` against the base commit; test.patch must apply first and gold.patch on top of it. Skip paths the repository marks \`export-ignore\` in .gitattributes: the agent's snapshot is a \`git archive\` and will not contain them.

\`\`\`json
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
\`\`\`

\`testCommand\` contains \`{tests}\` exactly once; failToPass and passToPass are the selectors it receives. Paths are repository-relative. testSelection.mode is reused, augmented, or authored. For exact per-test results, add \`"testResults": {"format": "junit", "failToPass": ["classname::name"], "passToPass": [...]}\`, write the report to "$SELFBENCH_JUNIT_REPORT" on every run, and install python3 in rootSetupCommand.`;

const isolateTests = `# Isolate the Tests

- gold.patch and test.patch touch different files. Fail-to-pass tests fail on the base, pass with gold, every time.
- Test through a public boundary. Don't import private helpers from the gold patch, and don't pin SQL, error wording, UI copy, or response shapes the request doesn't ask for. A different correct implementation must pass.
- Backend + frontend change: test the backend contract, not a mocked frontend.`;

const fairInstruction = `# Keep the Instruction Fair

- Write it as the engineer asking, from the original request; keep everything the tests check.
- No PR, commits, test names, or implementation details.
- If the tests depend on a specific name or interface, the instruction must state it.`;

const environment = `# Environment

- Derive it from the repository's CI: an @sha256-pinned image, a setupCommand that installs and builds, and a smokeCommand that prints what it checks. Only literal, non-secret environment values.
- The harness applies the patch and then runs only testCommand. If the tests need a rebuild of the changed source, testCommand must do that build.`;

const tierLine = (
  Object.entries(difficultyThresholds) as [string, (typeof difficultyThresholds)["easy"]][]
)
  .map(
    ([tier, t]) =>
      `${tier}: ≥${t.changedLines} changed implementation lines across ≥${t.implementationFiles} file${t.implementationFiles === 1 ? "" : "s"}, ≥${t.passToPass} pass-to-pass`,
  )
  .join("; ");

const difficulty = `# Difficulty

Keep or lower the tier, never raise it. ${tierLine}. verify enforces these.`;

const howToWork = (round: number): string => `# How to Work

- verify is the test harness. Don't install dependencies or run test suites in this sandbox; read code and git history instead.
- Read several files per tool call. Keep reasoning short.
- Draft all four files early, call verify, fix what the report names, repeat. You have ${AUTHOR_VERIFY_BUDGET} verify calls this round (round ${round} of ${MAX_AUTHORING_ROUNDS}).
- Green: call submit_task and stop. Out of calls: submit your best draft anyway.
- If the PR can't be a fair task, explain why and stop.`;

const reviewerFeedback = (feedback?: string): string =>
  feedback
    ? `# Reviewer Suggestions\n\n${feedback}\n\nAddress these in the deliverable, without adding behavior beyond the original request.`
    : "";

export function authoringPrompt(candidate: Candidate, feedback?: string): string {
  return joinPromptSections(
    assignment(candidate),
    deliverable,
    isolateTests,
    fairInstruction,
    environment,
    difficulty,
    howToWork(1),
    reviewerFeedback(feedback),
  );
}

export function authoringResumePrompt(
  round: number,
  renderedReport: string,
  feedback?: string,
): string {
  const reason = feedback
    ? "The read-only reviewer requested revisions. The report below describes your latest tested draft, not a failed check."
    : "Your previous submission did not pass mechanical verification. Read the report below and address its failures.";
  return joinPromptSections(
    `# Revise the Task\n\n${reason}\n\nThis is a fresh sandbox: the repository was re-cloned and /work/task is empty, so recreate all four files.`,
    howToWork(round),
    reviewerFeedback(feedback),
    `# Mechanical Check Report\n\n${renderedReport.trim()}`,
  );
}
