import { expect, test } from "bun:test";
import { datasetBlock, searchRegistry } from "./registry-search";

const registry = [
  { name: "acme/terminal-tools", description: "Shell tasks for terminal agents.", tasks: 12 },
  { name: "aider/aider-polyglot", description: "Polyglot code editing.", tasks: 225 },
  { name: "scale-ai/swe-bench-pro", description: "Harder SWE-bench tasks.", tasks: 731 },
  { name: "swe-bench/swe-bench-verified", description: "Human-validated SWE-bench.", tasks: 500 },
  { name: "terminal-bench/terminal-bench-2", description: "Terminal tasks.", tasks: 89 },
  { name: "terminal-bench/terminal-bench-2-1", tasks: 89 },
  { name: "zeta/café-bench", tasks: 3 },
];
const names = (typed: string) => searchRegistry(registry, typed).map((dataset) => dataset.name);

test("results rank name matches above description matches, popular datasets first", () => {
  // Nothing typed: the popular datasets lead, the rest follow by name.
  expect(names("")).toEqual([
    "terminal-bench/terminal-bench-2",
    "swe-bench/swe-bench-verified",
    "aider/aider-polyglot",
    "acme/terminal-tools",
    "scale-ai/swe-bench-pro",
    "terminal-bench/terminal-bench-2-1",
    "zeta/café-bench",
  ]);
  // The org's own datasets beat another org's dataset of the same start, which beats a word
  // inside a name, which beats a description.
  expect(names("terminal")).toEqual([
    "terminal-bench/terminal-bench-2",
    "terminal-bench/terminal-bench-2-1",
    "acme/terminal-tools",
  ]);
  expect(names("swe")).toEqual(["swe-bench/swe-bench-verified", "scale-ai/swe-bench-pro"]);
  expect(names("polyglot")).toEqual(["aider/aider-polyglot"]);
  expect(names("human validated")).toEqual(["swe-bench/swe-bench-verified"]);
  // A typed ref searches by the name before it; accents and case are ignored.
  expect(names("aider/aider-polyglot@1.0")).toEqual(["aider/aider-polyglot"]);
  expect(names("CAFE")).toEqual(["zeta/café-bench"]);
  expect(names("nothing-like-this")).toEqual([]);
});

test("added datasets and ones over the task limit can't be picked", () => {
  const [, polyglot, pro, verified] = registry;
  expect(datasetBlock(polyglot!, ["aider/aider-polyglot"])).toBe("Added");
  expect(datasetBlock(pro!, [])).toBe("Over 500 tasks");
  expect(datasetBlock(verified!, [])).toBeUndefined();
});
