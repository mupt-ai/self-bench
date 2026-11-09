import { expect, test } from "bun:test";
import { MAX_SKILLS } from "../../../../src/contracts/conditions";
import { facets, matchingFacets } from "./configuration-facets";
import { conditionsProblem } from "./RunConditionsPanel";
import { credentials, NOW, passed, run } from "./results-fixture";
import { configurationsOf } from "./results-model";
import { configurationName } from "./results-presentation";
import { restoreRunDraft } from "./run-draft";

const condition = { id: "abc123", name: "With Skills", skills: ["https://github.com/a/b"] };

test("a run condition is its own configuration, named and filtered apart from the baseline", () => {
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
  if (!facet) throw new Error("no Condition facet");
  const chosen = matchingFacets(configurations, { condition: ["Baseline"] });
  expect(chosen.map((configuration) => configuration.condition)).toEqual([undefined]);
});

test("a draft holding the most skills a condition takes still restores", () => {
  const skills = Array.from({ length: MAX_SKILLS }, (_, at) => `acme/skills-${at}`);
  const draft = restoreRunDraft(null, null).draft;
  const saved = JSON.stringify({
    submitted: false,
    draft: { ...draft, conditions: [{ name: "Many", skills, instructions: "" }] },
  });
  expect(restoreRunDraft(saved, null).draft.conditions?.[0]?.skills).toEqual(skills);
  const over = { ...draft, conditions: [{ name: "Many", skills: [...skills, "acme/one-more"] }] };
  expect(conditionsProblem(over as never)).toBe(`Many can add at most ${MAX_SKILLS} skills.`);
});
