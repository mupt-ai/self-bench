import { expect, test } from "bun:test";
import { sameScope, scopeKey, scopeOf } from "../src/evaluation/scope.js";
import { evaluationPrefix } from "../src/evaluation/store.js";

const id = "3e8423bb-e1c7-4f93-b34f-a892237659b0";

test("a repository's evaluations keep their storage; a benchmark gets its own", () => {
  expect(evaluationPrefix({ repoId: 7 }, id)).toBe(`evaluations/repos/7/${id}/`);
  expect(evaluationPrefix({ benchmarkId: 7 }, id)).toBe(`evaluations/benchmarks/7/${id}/`);
  // Workflow ids of repository runs are unchanged, so running ones can still be cancelled.
  expect(scopeKey({ repoId: 7 })).toBe("7");
  expect(scopeKey({ benchmarkId: 7 })).toBe("benchmark-7");
  expect(sameScope({ repoId: 7 }, { benchmarkId: 7 })).toBe(false);
  // A run carries more than its scope; only the scope's own fields are kept.
  const run = { id, repoId: 7 };
  expect(scopeOf(run)).toEqual({ repoId: 7 });
});

test("an evaluation names exactly one valid scope", () => {
  for (const invalid of [{}, { repoId: 1, benchmarkId: 1 }, { repoId: 0 }, { benchmarkId: 1.5 }])
    expect(() => scopeOf(invalid)).toThrow("Invalid evaluation identity");
  expect(() => evaluationPrefix({ repoId: 1 }, "../x")).toThrow("Invalid evaluation identity");
});
