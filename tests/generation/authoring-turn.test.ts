import { expect, test } from "bun:test";
import { verifyResultPrompt } from "../../src/generation/pipeline/authoring.js";
import { redReport } from "../support/workflow-fixture.js";

test("the turn after a verify carries the report and the next step", () => {
  const red = redReport("authoring", 1, "t", { oracle: true });
  expect(verifyResultPrompt(red, 2)).toContain("green=false. 2 verify call(s) remain");
  expect(verifyResultPrompt(red, 2)).toContain("verify again");
  expect(verifyResultPrompt(red, 0)).toContain("call submit_task with your best task");
  expect(verifyResultPrompt({ ...red, green: true }, 1)).toContain("Call submit_task now.");
});
