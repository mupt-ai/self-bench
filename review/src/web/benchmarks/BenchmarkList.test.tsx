import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { benchmarkRefusal } from "./AddBenchmarkCard";
import { BenchmarkList } from "./BenchmarkList";

test("each benchmark is a box like a repository's, with one more box to add a dataset", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <BenchmarkList
        benchmarks={[
          {
            id: 1,
            name: "terminal-bench/terminal-bench-2",
            ref: "latest",
            tasks: 89,
            runs: 3,
            addedAt: new Date().toISOString(),
          },
        ]}
        onAdd={async () => {}}
        onRemove={() => {}}
      />
    </MemoryRouter>,
  );
  expect(html).toContain('href="/benchmarks/terminal-bench/terminal-bench-2"');
  expect(html).toContain('aria-label="Open terminal-bench/terminal-bench-2"');
  expect(html).toContain(">89</dd>");
  expect(html).toContain(">3</dd>");
  expect(html).toContain(">latest</dd>");
  expect(html).toContain('aria-label="Add a Dataset"');
});

test("a dataset is checked before it is added", () => {
  const added = ["terminal-bench/terminal-bench-2"];
  expect(benchmarkRefusal("swe-bench/swe-bench-verified", added)).toBeUndefined();
  expect(benchmarkRefusal("swe-bench/swe-bench-verified@1.0", added)).toBeUndefined();
  expect(benchmarkRefusal("--help", added)).toBe(
    "Enter a dataset such as org/name or org/name@ref.",
  );
  expect(benchmarkRefusal("terminal-bench", added)).toBe(
    "Enter a dataset such as org/name or org/name@ref.",
  );
  expect(benchmarkRefusal("terminal-bench/terminal-bench-2@2.0", added)).toBe(
    "terminal-bench/terminal-bench-2 is already added.",
  );
});
