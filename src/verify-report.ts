import type { HarborRewards, VerifyReport } from "./contracts.js";

const NOP_EXPECTATIONS: Readonly<Record<string, string>> = {
  patch_applied: "1",
  setup_completed: "1",
  fail_to_pass: "0",
  pass_to_pass: "1",
};
const ORACLE_EXPECTATIONS: Readonly<Record<string, string>> = {
  patch_applied: "1",
  setup_completed: "1",
  fail_to_pass: "1",
  pass_to_pass: "1",
  deterministic: "1",
};

export function nopGatePassed(rewards: HarborRewards): boolean {
  return (
    reward(rewards, "patch_applied") >= 1 &&
    reward(rewards, "setup_completed") >= 1 &&
    reward(rewards, "fail_to_pass") === 0 &&
    reward(rewards, "pass_to_pass") >= 1
  );
}

export function oracleGatePassed(rewards: HarborRewards): boolean {
  return Object.keys(ORACLE_EXPECTATIONS).every((key) => reward(rewards, key) >= 1);
}

export function isGreen(report: Omit<VerifyReport, "green">): boolean {
  return (
    report.compile.ok &&
    report.audit.ok &&
    report.build.ok &&
    report.smoke.ok &&
    report.nop.ok &&
    report.oracle.ok
  );
}

/** One-line reason suitable for a rejection message or progress status. */
export function verifyReportSummary(report: VerifyReport): string {
  const label = `${report.stage} round ${report.round}`;
  if (report.green) {
    return `${label}: all gates green`;
  }
  const failures: string[] = [];
  if (!report.compile.ok) {
    failures.push(`compile: ${report.compile.errors[0] ?? "failed"}`);
  }
  if (!report.audit.ok) {
    failures.push(`audit: ${report.audit.blockers[0] ?? "blocked"}`);
  }
  if (report.build.ran && !report.build.ok) {
    failures.push(
      report.build.infrastructure ? "image build: infrastructure failure" : "image build failed",
    );
  }
  if (report.smoke.ran && !report.smoke.ok) {
    failures.push("smoke command failed");
  }
  if (report.nop.ran && !report.nop.ok) {
    failures.push(`nop: ${rewardSummary(report.nop.rewards, NOP_EXPECTATIONS)}`);
  }
  if (report.oracle.ran && !report.oracle.ok) {
    failures.push(`oracle: ${rewardSummary(report.oracle.rewards, ORACLE_EXPECTATIONS)}`);
  }
  return `${label}: ${failures.length > 0 ? failures.join("; ") : "gates did not run"}`;
}

/** Concise markdown for the agent's next turn. */
export function renderVerifyReport(report: VerifyReport): string {
  const sections = [
    `# Verification report: ${report.stage} round ${report.round} for ${report.taskId}`,
    "",
    `Overall: **${report.green ? "GREEN" : "RED"}** — ${verifyReportSummary(report)}`,
    "",
    "## 1. Trusted compiler and environment policy",
    report.compile.ok ? "OK." : bulletList(report.compile.errors, "Compilation failed."),
    "",
    "## 2. Static audit",
    report.audit.ok ? "OK." : bulletList(report.audit.blockers, "Audit blocked the task."),
    "",
    "## 3. Image build",
    gateText(report.build, report.build.infrastructure ? "failed (infrastructure)" : "failed"),
    "",
    "## 4. Smoke command (verifier image, runtime user)",
    gateText(report.smoke, "failed"),
    "",
    "## 5. nop run (base snapshot + held-out tests, no solution)",
    `Expected ${expectationText(NOP_EXPECTATIONS)}.`,
    rewardGateText(report.nop),
    "",
    "## 6. oracle run (reference patch applied)",
    `Expected ${expectationText(ORACLE_EXPECTATIONS)}.`,
    rewardGateText(report.oracle),
  ];
  return `${sections.join("\n").trimEnd()}\n`;
}

function gateText(gate: VerifyReport["build"] | VerifyReport["smoke"], failure: string): string {
  if (!gate.ran) {
    return "Not run (an earlier gate failed).";
  }
  const status = gate.ok ? "OK." : `Result: ${failure}.`;
  return gate.logTail.trim() ? `${status}\n\n\`\`\`text\n${gate.logTail.trim()}\n\`\`\`` : status;
}

function rewardGateText(gate: VerifyReport["nop"]): string {
  if (!gate.ran) {
    return "Not run (an earlier gate failed).";
  }
  const rows = Object.entries(gate.rewards)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `| ${key} | ${value} |`);
  const table =
    rows.length > 0
      ? ["| reward | value |", "| --- | --- |", ...rows].join("\n")
      : "No rewards recorded.";
  const status = gate.ok ? "Result: OK." : "Result: FAILED.";
  const log = gate.logTail.trim() ? `\n\n\`\`\`text\n${gate.logTail.trim()}\n\`\`\`` : "";
  return `${status}\n\n${table}${log}`;
}

function bulletList(items: readonly string[], heading: string): string {
  return items.length === 0
    ? heading
    : `${heading}\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function expectationText(expectations: Readonly<Record<string, string>>): string {
  return Object.entries(expectations)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function rewardSummary(
  rewards: HarborRewards,
  expectations: Readonly<Record<string, string>>,
): string {
  const mismatches = Object.entries(expectations)
    .filter(([key, expected]) => String(rewards[key] ?? "missing") !== expected)
    .map(([key, expected]) => `${key}=${String(rewards[key] ?? "missing")} (expected ${expected})`);
  return mismatches.length > 0 ? mismatches.join(", ") : "rewards did not meet the gate";
}

function reward(rewards: HarborRewards, key: string): number {
  const value = rewards[key];
  return typeof value === "number" ? value : Number.NaN;
}
