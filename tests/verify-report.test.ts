import { describe, expect, test } from "bun:test";
import type { VerifyReport } from "../src/contracts.js";
import {
  isGreen,
  nopGatePassed,
  oracleGatePassed,
  renderVerifyReport,
  verifyReportSummary,
} from "../src/verify-report.js";

const greenReport: VerifyReport = {
  schemaVersion: 1,
  stage: "authoring",
  round: 1,
  taskId: "example-task",
  compile: { ok: true, errors: [] },
  audit: { ok: true, blockers: [] },
  build: { ran: true, ok: true, logTail: "", infrastructure: false },
  smoke: { ran: true, ok: true, logTail: "node v22.0.0" },
  nop: {
    ran: true,
    ok: true,
    rewards: { patch_applied: 1, setup_completed: 1, fail_to_pass: 0, pass_to_pass: 1 },
    logTail: "",
  },
  oracle: {
    ran: true,
    ok: true,
    rewards: {
      patch_applied: 1,
      setup_completed: 1,
      fail_to_pass: 1,
      pass_to_pass: 1,
      deterministic: 1,
    },
    logTail: "",
  },
  green: true,
};

describe("verify report", () => {
  test("evaluates the nop and oracle gates from rewards", () => {
    expect(nopGatePassed(greenReport.nop.rewards)).toBe(true);
    expect(nopGatePassed({ ...greenReport.nop.rewards, fail_to_pass: 1 })).toBe(false);
    expect(nopGatePassed({ patch_applied: 1 })).toBe(false);
    expect(oracleGatePassed(greenReport.oracle.rewards)).toBe(true);
    expect(oracleGatePassed({ ...greenReport.oracle.rewards, deterministic: 0 })).toBe(false);
    expect(isGreen(greenReport)).toBe(true);
    expect(isGreen({ ...greenReport, smoke: { ran: true, ok: false, logTail: "boom" } })).toBe(
      false,
    );
  });

  test("summarises the first failing gates in order", () => {
    expect(verifyReportSummary(greenReport)).toBe("authoring round 1: all gates green");
    const red: VerifyReport = {
      ...greenReport,
      round: 2,
      compile: { ok: false, errors: ["environment variable SECRET_KEY looks like a secret"] },
      audit: { ok: false, blockers: ["gold and held-out test patches overlap: src/a.ts"] },
      build: { ran: false, ok: false, logTail: "", infrastructure: false },
      smoke: { ran: false, ok: false, logTail: "" },
      nop: { ran: false, ok: false, rewards: {}, logTail: "" },
      oracle: { ran: false, ok: false, rewards: {}, logTail: "" },
      green: false,
    };
    expect(verifyReportSummary(red)).toBe(
      "authoring round 2: compile: environment variable SECRET_KEY looks like a secret; audit: gold and held-out test patches overlap: src/a.ts",
    );
    const oracleFailed: VerifyReport = {
      ...greenReport,
      stage: "verification",
      oracle: {
        ran: true,
        ok: false,
        rewards: { ...greenReport.oracle.rewards, fail_to_pass: 0 },
        logTail: "FAIL tests/new.test.ts",
      },
      green: false,
    };
    expect(verifyReportSummary(oracleFailed)).toBe(
      "verification round 1: oracle: fail_to_pass=0 (expected 1)",
    );
    const infrastructure: VerifyReport = {
      ...greenReport,
      build: { ran: true, ok: false, logTail: "ImageBuildError", infrastructure: true },
      smoke: { ran: false, ok: false, logTail: "" },
      nop: { ran: false, ok: false, rewards: {}, logTail: "" },
      oracle: { ran: false, ok: false, rewards: {}, logTail: "" },
      green: false,
    };
    expect(verifyReportSummary(infrastructure)).toBe(
      "authoring round 1: image build: infrastructure failure",
    );
  });

  test("renders concise markdown with log tails and reward tables", () => {
    const rendered = renderVerifyReport({
      ...greenReport,
      build: {
        ran: true,
        ok: false,
        logTail: "E: Unable to locate package foo",
        infrastructure: false,
      },
      smoke: { ran: false, ok: false, logTail: "" },
      nop: { ran: false, ok: false, rewards: {}, logTail: "" },
      oracle: { ran: false, ok: false, rewards: {}, logTail: "" },
      green: false,
    });
    expect(rendered).toContain("# Verification report: authoring round 1 for example-task");
    expect(rendered).toContain("Overall: **RED**");
    expect(rendered).toContain(
      "## 3. Image build\nResult: failed.\n\n```text\nE: Unable to locate package foo\n```",
    );
    expect(rendered).toContain("## 4. Smoke command (verifier image, runtime user)\nNot run");
    const green = renderVerifyReport(greenReport);
    expect(green).toContain("Overall: **GREEN**");
    expect(green).toContain("| fail_to_pass | 0 |");
    expect(green).toContain("| deterministic | 1 |");
    expect(green).toContain(
      "## 4. Smoke command (verifier image, runtime user)\nOK.\n\n```text\nnode v22.0.0\n```",
    );
  });
});
