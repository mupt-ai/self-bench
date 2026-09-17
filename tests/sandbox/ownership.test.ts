import { expect, test } from "bun:test";
import {
  attachCleanupFailure,
  hasOwnershipFailure,
  markOwnershipFailure,
  supervisionFailure,
} from "../../src/sandbox/ownership.js";

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

const annotated = {
  detail: "Provider cleanup also failed: sanitized detail",
  aggregateMessage: "Provider execution and cleanup both failed",
};

for (const frozen of [false, true]) {
  test(`cleanup attachment preserves ${frozen ? "frozen cause and name" : "extensible identity and cause"}`, () => {
    const cause = new Error("original cause");
    const primary = new TypeError("primary", { cause });
    if (frozen) Object.freeze(primary);
    const cleanup = new Error("sanitized detail");
    const combined = attachCleanupFailure(primary, cleanup, annotated);
    expect(combined === primary).toBe(!frozen);
    expect(combined.cause).toBe(frozen ? primary : cause);
    expect(combined.name).toBe("TypeError");
    expect(combined.message).toBe("primary; Provider cleanup also failed: sanitized detail");
    expect(combined.cleanupError).toBe(cleanup);
    expect(hasOwnershipFailure(combined)).toBe(true);
    expect(Object.keys(combined)).not.toContain("cleanupError");
    if (frozen) expect(primary.message).toBe("primary");
  });

  test(`preserved-message cleanup retains Modal policy with ${frozen ? "frozen" : "extensible"} errors`, () => {
    const primary = new TypeError("primary");
    if (frozen) Object.freeze(primary);
    const combined = attachCleanupFailure(primary, undefined, {
      fallbackMessage: "Modal execution and cleanup failed",
    });
    expect(combined === primary).toBe(!frozen);
    expect(combined.message).toBe(frozen ? "Modal execution and cleanup failed" : "primary");
    expect(combined.name).toBe(frozen ? "Error" : "TypeError");
    if (frozen) expect(combined.cause).toBe(primary);
    expect("cleanupError" in combined).toBe(true);
    expect(hasOwnershipFailure(combined)).toBe(true);
  });

  test(`ownership marker keeps a lazy late failure across ${frozen ? "frozen fallback" : "original identity"}`, () => {
    const primary = new TypeError("primary");
    if (frozen) Object.freeze(primary);
    let late: unknown;
    let reads = 0;
    const combined = markOwnershipFailure(primary, () => {
      reads++;
      return late;
    });
    expect(combined === primary).toBe(!frozen);
    expect(combined.name).toBe("TypeError");
    expect(combined.message).toBe("primary");
    if (frozen) expect(combined.cause).toBe(primary);
    expect(reads).toBe(0);
    expect(hasOwnershipFailure(combined)).toBe(true);
    expect(reads).toBe(0);
    expect(combined.supervisionError).toBeUndefined();
    late = new Error("late supervision rejection");
    expect(combined.supervisionError).toBe(late);
    expect(reads).toBe(2);
  });
}

test("primitive rejections retain provider aggregation or Modal cause and always carry cleanup markers", () => {
  const cleanup = new Error("cleanup");
  const aggregate = attachCleanupFailure("primary", cleanup, annotated);
  expect(aggregate).toBeInstanceOf(AggregateError);
  if (!(aggregate instanceof AggregateError)) throw new Error("expected aggregate rejection");
  expect(aggregate.errors).toEqual(["primary", cleanup]);
  expect(aggregate.message).toBe(annotated.aggregateMessage);
  expect(aggregate.cleanupError).toBe(cleanup);
  expect(hasOwnershipFailure(aggregate)).toBe(true);
  const modal = attachCleanupFailure(undefined, cleanup, {
    fallbackMessage: "Modal execution and cleanup failed",
  });
  expect(modal).not.toBeInstanceOf(AggregateError);
  expect("cause" in modal).toBe(true);
  expect(modal.cause).toBeUndefined();
  expect(modal.cleanupError).toBe(cleanup);
});

test("protected descriptors do not partially mutate the original before wrapping", () => {
  const primary = new Error("fixed");
  Object.defineProperty(primary, "message", { value: "fixed", configurable: false });
  const combined = attachCleanupFailure(primary, new Error("cleanup"), annotated);
  expect(combined).not.toBe(primary);
  expect(combined.cause).toBe(primary);
  expect(primary.message).toBe("fixed");
  expect("cleanupError" in primary).toBe(false);
  expect(hasOwnershipFailure(combined)).toBe(true);
});

test("cleanup attachment preserves dynamic supervision evidence and the primary error identity", () => {
  const primary = new Error("transport");
  let late: unknown;
  const owned = markOwnershipFailure(primary, () => late);
  const combined = attachCleanupFailure(owned, new Error("cleanup"), annotated);
  late = new Error("late owned-work rejection");
  expect(combined === primary).toBe(true);
  expect(owned.supervisionError).toBe(late);
  expect(hasOwnershipFailure(combined)).toBe(true);
});

test("ownership selection preserves fatal errors but retains ordinary termination precedence", async () => {
  const { selectSandboxFailure } = await import("../../src/sandbox/ownership.js");
  const ordinary = Object.freeze(new Error("operation"));
  const deadline = new Error("deadline");
  expect(selectSandboxFailure(ordinary, deadline)).toBe(deadline);
  expect(selectSandboxFailure(ordinary, undefined)).toBe(ordinary);
  const fatal = supervisionFailure(ordinary, new Error("supervision"));
  expect(selectSandboxFailure(fatal, deadline)).toBe(fatal);
  const aggregate = new AggregateError([fatal]);
  aggregate.cause = aggregate;
  expect(selectSandboxFailure(aggregate, deadline)).toBe(aggregate);
});
