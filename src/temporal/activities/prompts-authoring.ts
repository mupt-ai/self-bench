import {
  AUTHOR_VERIFY_BUDGET,
  type Candidate,
  MAX_AUTHORING_ROUNDS,
  type RunRequest,
} from "../../contracts.js";
import {
  AUTHORING_TEST_EVIDENCE,
  DELIVERABLE,
  ENVIRONMENT_CONTRACT,
  HELD_OUT_TESTS,
  joinPromptSections,
  SUBMISSION,
  VERIFY,
} from "./prompt-sections.js";

const authoringRole = (run: RunRequest, candidate: Candidate): string => `# Assignment

Author exactly one SelfBench task for this assigned candidate. The initial ${candidate.difficulty} difficulty is only a heuristic; choose a lower tier when the actual implementation is smaller. Use only this candidate. Do not discover alternatives or run Harbor. Read /work/provenance.json only to verify the supplied authentic request. Inspect the base and completed commits. Split the completed change into a non-test gold patch and a held-out test patch. Use the highest honest tier supported by the implementation and tests. Do not pad the change to reach a tier threshold.

## Candidate

${JSON.stringify(
  {
    sourcePr: candidate.sourcePr,
    sourceUrl: candidate.sourceUrl,
    baseCommit: candidate.baseCommit,
    completedCommit: candidate.completedCommit,
    request: candidate.request,
    runId: run.runId,
  },
  null,
  2,
)}`;

const reviewerFeedback = (feedback?: string): string =>
  feedback
    ? `# Read-Only Verifier Suggestions\n\n${feedback}\n\nAddress these suggestions in the deliverable, but do not add behavior beyond the authentic request.`
    : "";

const roundInstructions = (
  round: number,
  resumed: boolean,
): string => `# Round ${round} of ${MAX_AUTHORING_ROUNDS}

${resumed ? "Read the previous report and rewrite the deliverable to address its failures or the reviewer's suggestions." : "Create the deliverable from the authentic request."} You have a fresh budget of ${AUTHOR_VERIFY_BUDGET} verify calls in this authoring round. Use verify until the task is green, then call submit_task exactly once and stop. If the budget is exhausted, submit your best deliverable; a red worker result starts the next round.`;

const verifyInstructions = `${VERIFY}\n\nEach authoring round has ${AUTHOR_VERIFY_BUDGET} verify calls. A successful submission matching its last green verify lets the worker reuse that report.`;

export function authoringPrompt(run: RunRequest, candidate: Candidate, feedback?: string): string {
  return joinPromptSections(
    authoringRole(run, candidate),
    reviewerFeedback(feedback),
    AUTHORING_TEST_EVIDENCE,
    HELD_OUT_TESTS,
    ENVIRONMENT_CONTRACT,
    DELIVERABLE,
    SUBMISSION,
    roundInstructions(1, false),
    verifyInstructions,
  );
}

export function authoringResumePrompt(
  round: number,
  renderedReport: string,
  feedback?: string,
): string {
  const reason = feedback
    ? "The read-only reviewer requested revisions. The mechanical report describes the latest tested draft, not necessarily a failed check."
    : "Your previous submission did not pass mechanical verification. Address the failures in the report.";
  return joinPromptSections(
    `# ${reason}`,
    roundInstructions(round, true),
    DELIVERABLE,
    SUBMISSION,
    verifyInstructions,
    `# Verification Report\n\n${renderedReport.trim()}`,
    reviewerFeedback(feedback),
  );
}
