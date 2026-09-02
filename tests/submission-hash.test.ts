import { describe, expect, test } from "bun:test";
import { matchingGreenVerify, submissionHash } from "../src/submission-hash.js";

describe("submission hash", () => {
  test("is stable across object and pretty-printed JSON forms of the same definition", () => {
    const definition = { taskId: "t", environment: { baseImage: "x" }, prompt: "p" };
    const fromObject = submissionHash({ definition, testPatch: "diff", goldPatch: "gold" });
    const fromJson = submissionHash({
      definition: JSON.stringify(definition, null, 2),
      testPatch: "diff",
      goldPatch: "gold",
    });
    expect(fromObject).toBe(fromJson);
    expect(fromObject).toMatch(/^[0-9a-f]{64}$/);
    expect(submissionHash({ definition, testPatch: "diff2", goldPatch: "gold" })).not.toBe(
      fromObject,
    );
  });

  test("matches the latest green verify with the same payload", () => {
    const verifies = [
      { hash: "a", green: false, k: 1 },
      { hash: "a", green: true, k: 2 },
      { hash: "b", green: true, k: 3 },
      { hash: "a", green: true, k: 4 },
      { hash: "a", green: false, k: 5 },
    ];
    expect(matchingGreenVerify("a", verifies)?.k).toBe(4);
    expect(matchingGreenVerify("b", verifies)?.k).toBe(3);
    expect(matchingGreenVerify("c", verifies)).toBeUndefined();
    expect(matchingGreenVerify("a", [{ hash: "a", green: false }])).toBeUndefined();
  });
});
