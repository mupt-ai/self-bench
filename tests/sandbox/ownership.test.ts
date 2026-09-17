import { expect, test } from "bun:test";
import { hasOwnershipFailure, supervisionFailure } from "../../src/sandbox/ownership.js";

test("ownership survives frozen causes, aggregates and cycles without reclassifying ordinary failures", () => {
  const primary = Object.freeze(new Error("transport"));
  const supervision = new Error("stuck");
  const fatal = supervisionFailure(primary, supervision);
  expect(fatal.cause).toBe(primary);
  expect(fatal.supervisionError).toBe(supervision);
  expect(
    hasOwnershipFailure(new AggregateError([primary, new Error("wrapper", { cause: fatal })])),
  ).toBe(true);
  expect(hasOwnershipFailure(primary)).toBe(false);
  const cycle = new Error("cycle");
  cycle.cause = cycle;
  expect(hasOwnershipFailure(cycle)).toBe(false);
  expect(
    hasOwnershipFailure(
      Object.defineProperty(new Error("cleanup"), "cleanupError", { value: undefined }),
    ),
  ).toBe(true);
});
