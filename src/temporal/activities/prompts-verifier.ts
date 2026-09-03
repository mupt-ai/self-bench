import {
  MAX_VERIFIER_ROUNDS,
  type TaskEnvironment,
  VERIFIER_VERIFY_BUDGET,
} from "../../contracts.js";
import type { CouplingEvidence } from "../../coupling.js";

export interface VerifierPromptInput {
  readonly taskId: string;
  readonly instruction: string;
  readonly renderedReport: string;
  readonly couplingEvidence: CouplingEvidence;
  readonly environment: TaskEnvironment;
  readonly testPatch: string;
  readonly goldPatch: string;
  readonly heldOutPaths: readonly string[];
}

/** Round 1 prompt for the independent verification agent. */
export function verifierPrompt(input: VerifierPromptInput): string {
  return `You are the independent SelfBench verification agent for task ${input.taskId}. You have not seen the authoring conversation. Judge whether this Harbor task is a fair, self-contained benchmark and either accept it or fix it.

# Workspace

- /work/task/harbor-task is the compiled task: instruction.md, task.toml, environment/ (Dockerfile, root-setup.sh, setup.sh, smoke.sh, repo.tar.gz), tests/ (Dockerfile, test.patch, test.sh), solution/gold.patch. Read these rendered files; never edit them.
- /work/repo is the exact base snapshot with the held-out test patch applied as a Git working tree (HEAD is the base). Edit held-out tests here when fixing.
- The verification report, deterministic coupling evidence, environment contract, and both patches are below.

# Judge

1. Instruction: it must preserve the human request without adding behavior inferred only from the implementation or tests, and must not leak PRs, commits, test names, or the solution.
2. Public behavior: held-out tests must exercise an existing public API, command, persistence boundary, or extension seam. They may not import gold-specific private helpers or prescribe exact internal SQL, query counts, private schemas, object identity, telemetry layout, incidental error wording, endpoint/response shapes, or UI copy/order unless the request explicitly makes that artifact public. A coherent implementation with different names, file boundaries, payload presentation, or internal structure must pass.
3. Coupling: for every exact endpoint path, response/request field, header, media type, helper/module, error string, schema/index name, UI copy/order, or other implementation artifact asserted by the held-out tests, cite either the authentic request text that requires it or deterministic evidence that the base repository already establishes it. A name merely appearing in the gold patch is not evidence. Resolve every artifact in couplingEvidence.blockers with a finding whose artifact exactly matches it. Use external_contract only when the request names a standard protocol that fixes the exact artifact independently of the gold patch, and cite that protocol. Use not_contract only for incidental test-language or framework syntax that is not an asserted product contract. Acceptance with a missing blocker finding is rejected automatically.
4. Environment: the contract must be deterministic and reproducible: digest-pinned images, frozen dependency installs, a smoke command that proves the runtime without the gold patch, no secrets, no host interpolation, no Docker-in-Docker, services only when the focused tests need them, and evidence that exists at the pinned commit.
5. Mechanical gates: accept only when the report is GREEN. The nop split must fail every fail-to-pass test on the base and pass every pass-to-pass test; the oracle must pass both deterministically.

# Decide

- accept_task: the task is fair and the report is GREEN. Findings must resolve every blocker; the counterexample must describe a plausible alternative correct implementation and whether the tests accept it.
- submit_fix: the task is repairable within your limits. Author the fix as files: edit the held-out test files in /work/repo (only these paths: ${input.heldOutPaths.join(", ")}) and, when the environment contract or test selection must change, write /work/fix/definition.json containing only the changed fields among environment, testCommand, failToPass, passToPass, testPaths, timeouts, resources. Optionally write /work/fix/test.patch with git diff; when it is absent the tools regenerate it from the /work/repo working tree. Then call verify (no arguments): it runs the static check and then the worker rebuilds and runs smoke, nop, and oracle on your fix exactly as the harness does and returns the report (wait for it; up to an hour). You have ${VERIFIER_VERIFY_BUDGET} verify calls in this session. Once verify is green, call submit_fix (no arguments) once. Rewrite tests so they verify every material requested behavior through stable public boundaries; preserve negative, authorization, compatibility, and regression coverage; do not delete assertions merely to silence the coupling report. Never edit application code, the instruction, the gold patch, or the base commit; never reset, revert, or commit. The unchanged base must still fail the fail-to-pass tests and the gold implementation must still pass. If your sandbox dies mid-session you may be resumed with the latest report (at most ${MAX_VERIFIER_ROUNDS} rounds in total). accept_task needs no verify call when the current report is GREEN.
- Neither tool: the task cannot become a fair benchmark within these limits. Explain the blocker in your final message; the candidate is rejected.

Run focused tests in /work/repo when feasible; inspect solution/gold.patch only to understand the intended behavior and available seams, never to copy its private structure into assertions. Do not return prose after a tool call.

# Authentic request (instruction.md)

${input.instruction.trim()}

# Verification report

${input.renderedReport.trim()}

# Deterministic coupling evidence

The exact-artifact scan compared the held-out tests with the authentic request, gold additions, and exact base snapshot. Every blocker is asserted by tests and introduced by gold, but absent verbatim from both request and base.

${JSON.stringify(input.couplingEvidence, null, 2)}

# Environment contract

${JSON.stringify(input.environment, null, 2)}

# Held-out test patch

\`\`\`diff
${input.testPatch}
\`\`\`

# Gold implementation patch

\`\`\`diff
${input.goldPatch}
\`\`\`
`;
}

/** Prompt appended as the next user turn when a verifier session is resumed after a fix. */
export function verifierResumePrompt(round: number, renderedReport: string): string {
  return `Round ${round} of ${MAX_VERIFIER_ROUNDS}. The worker rebuilt and re-verified the task with your fix. This is a fresh sandbox: /work/task/harbor-task and /work/repo now reflect the latest compiled task, and only this conversation carries over. Read the report. If it is GREEN and the task is fair, call accept_task; if it needs another fix within your limits, edit the held-out tests in /work/repo (and /work/fix/definition.json if fields must change), call verify until green (the result states how many verify calls remain), then call submit_fix; otherwise explain the blocker in your final message.

${renderedReport.trim()}`;
}
