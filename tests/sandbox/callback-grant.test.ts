import { expect, test } from "bun:test";
import { readSandboxGrant, signSandboxGrant } from "../../src/sandbox/callback-grant.js";

const secret = "s".repeat(32);
const grant = {
  taskToken: Buffer.from("task").toString("base64"),
  prefix: "runs/r/verify/c/authoring-round-1/compile/attempt-1",
  sandbox: { sandboxId: "sb-1", stage: "compile-c", startedAt: "2026-09-23T00:00:00.000Z" },
  expiresAt: 2_000,
};

test("a signed grant reads back only with its secret and before it expires", () => {
  const token = signSandboxGrant(grant, secret);
  expect(readSandboxGrant(token, secret, 1_000)).toEqual(grant);
  expect(readSandboxGrant(token, "t".repeat(32), 1_000)).toBeUndefined();
  expect(readSandboxGrant(token, secret, 2_000)).toBeUndefined();
});

test("a grant whose payload was changed is rejected", () => {
  const [, mac] = signSandboxGrant(grant, secret).split(".");
  const widened = Buffer.from(JSON.stringify({ ...grant, prefix: "runs" })).toString("base64url");
  expect(readSandboxGrant(`${widened}.${mac}`, secret, 1_000)).toBeUndefined();
  expect(readSandboxGrant("not-a-token", secret, 1_000)).toBeUndefined();
});
