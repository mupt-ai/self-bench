import { expect, test } from "bun:test";
import { facets, matchingFacets } from "./configuration-facets";
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

test("a draft restores the conditions it picked, and one from before saved conditions keeps its models", () => {
  const draft = restoreRunDraft(null, null).draft;
  const models = [
    { catalogId: "gpt-6-sol", credentialId: "router", harnesses: ["codex" as const] },
  ];
  const saved = (conditions: unknown[]) =>
    restoreRunDraft(
      JSON.stringify({ submitted: false, draft: { ...draft, models, conditions } }),
      null,
    ).draft;
  const picked = [
    { saved: 3, environment: 7, subagentCredentialId: "managed-model" },
    { saved: 4 },
  ];
  expect(saved(picked).conditions).toEqual(picked);
  // Conditions were once written out on the Run page: those are dropped, not the whole draft.
  const written = saved([{ name: "Many", skills: ["acme/skills"], instructions: "" }]);
  expect(written.conditions).toEqual([]);
  expect(written.models).toEqual(models);
  expect(written.id).toBe(draft.id);
});
