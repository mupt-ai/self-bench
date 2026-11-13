import { expect, test } from "bun:test";
import { facets, matchingFacets } from "./configuration-facets";
import { credentials, NOW, passed, run } from "./results-fixture";
import { configurationsOf } from "./results-model";
import { configurationName } from "./results-presentation";

const condition = { id: "abc123", name: "With Skills", skills: ["https://github.com/a/b"] };

test("a run with a harness or repo ablation is its own configuration, named and filtered apart from the baseline", () => {
  const configurations = configurationsOf(
    [run("baseline", {}, [passed("task-1")]), run("skills", { condition }, [passed("task-1")])],
    credentials,
    NOW,
  );
  expect(configurations.map((configuration) => configuration.condition?.name)).toEqual(
    expect.arrayContaining([undefined, "With Skills"]),
  );
  expect(configurations.map(configurationName).sort()).toEqual([
    "GPT-6 · Codex",
    "GPT-6 · Codex · With Skills",
  ]);
  const facet = facets.find((entry) => entry.key === "condition");
  if (!facet) throw new Error("no Setup facet");
  expect([facet.label, facet.all]).toEqual(["Setup", "All Setups"]);
  const chosen = matchingFacets(configurations, { condition: ["Baseline"] });
  expect(chosen.map((configuration) => configuration.condition)).toEqual([undefined]);
});
