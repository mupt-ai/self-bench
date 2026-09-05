import type { TaskEnvironment } from "../../contracts.js";
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
  return `You are the independent SelfBench verification agent for task ${input.taskId}. You have not seen the authoring conversation. Judge whether this Harbor task is a fair, self-contained benchmark and either accept it or submit suggestions for the next authoring agent.

# Workspace

- /work/task/harbor-task is the compiled task: instruction.md, task.toml, environment/ (Dockerfile, root-setup.sh, setup.sh, smoke.sh, repo.tar.gz), tests/ (Dockerfile, test.patch, test.sh), solution/gold.patch. Read these rendered files; never edit them.
- /work/repo is the exact base snapshot with the held-out test patch applied as a Git working tree (HEAD is the base). It is read-only; do not edit it.
- The verification report, deterministic coupling evidence, environment contract, and both patches are below.

# Judge

1. Instruction: it must preserve the human request without adding behavior inferred only from the implementation or tests, and must not leak PRs, commits, test names, or the solution.
2. Public behavior: held-out tests must exercise an existing public API, command, persistence boundary, or extension seam. They may not import gold-specific private helpers or prescribe exact internal SQL, query counts, private schemas, object identity, telemetry layout, incidental error wording, endpoint/response shapes, or UI copy/order unless the request explicitly makes that artifact public. A coherent implementation with different names, file boundaries, payload presentation, or internal structure must pass.
3. Coupling: for every exact endpoint path, response/request field, header, media type, helper/module, error string, schema/index name, UI copy/order, or other implementation artifact asserted by the held-out tests, cite either the authentic request text that requires it or deterministic evidence that the base repository already establishes it. A name merely appearing in the gold patch is not evidence. Resolve every artifact in couplingEvidence.blockers with a finding whose artifact exactly matches it. Use external_contract only when the request names a standard protocol that fixes the exact artifact independently of the gold patch, and cite that protocol. Use not_contract only for incidental test-language or framework syntax that is not an asserted product contract. Acceptance with a missing blocker finding is rejected automatically.
4. Environment: the contract must be deterministic and reproducible: digest-pinned images, frozen dependency installs, a smoke command that proves the runtime without the gold patch, no secrets, no host interpolation, no Docker-in-Docker, services only when the focused tests need them, and evidence that exists at the pinned commit.
5. Mechanical gates: accept only when the report is GREEN. The nop split must fail every fail-to-pass test on the base and pass every pass-to-pass test; the oracle must pass both deterministically.

# Decide

- accept_task: the task is fair and the report is GREEN. Findings must resolve every blocker; the counterexample must describe a plausible alternative correct implementation and whether the tests accept it.
- submit_suggestions: the task needs changes, but you may not edit anything. Submit a concise summary and actionable suggestions for the next authoring agent. Do not prescribe private implementation details; identify fairness, public-seam, coupling, environment, or test issues.
- reject_task: the task cannot be made fair within the authoring workflow; explain the blocker.

The verifier has no bash, edit, write, or verify tools. It must not modify the task, tests, definition, patches, or repository.

Use read, grep, find, and ls to inspect the existing test evidence; inspect solution/gold.patch only to understand the intended behavior and available seams, never to copy its private structure into assertions. Do not return prose after a tool call.

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
