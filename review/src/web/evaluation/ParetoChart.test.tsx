import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ParetoChart } from "./ParetoChart";

test("single-harness charts label points by model name alone", () => {
  const html = renderToStaticMarkup(
    <ParetoChart
      points={[
        {
          id: "run-codex",
          runId: "run",
          name: "Model",
          provider: "openai",
          model: "openai/gpt-5.5",
          harness: "codex",
          accuracy: 75,
          cost: 0.1,
          tasks: 4,
          datasetKey: "dataset",
        },
        {
          id: "run-pi",
          runId: "run-2",
          name: "Cheaper",
          provider: "custom",
          model: "my-llama-70b",
          harness: "codex",
          accuracy: 60,
          cost: 0.05,
          tasks: 4,
          datasetKey: "dataset",
        },
      ]}
      onSelect={() => {}}
    />,
  );
  expect(html).toContain(">Model Comparison</text>");
  expect(html).toContain(">Model</text>");
  expect(html).toContain(">Cheaper</text>");
});

test("runs are grouped by vendor, with custom endpoints last", () => {
  const html = renderToStaticMarkup(
    <ParetoChart
      points={[
        {
          id: "run-custom",
          runId: "run",
          name: "my-llama-70b · high",
          provider: "custom",
          model: "my-llama-70b",
          harness: "codex",
          accuracy: 70,
          cost: 0.02,
          tasks: 4,
          datasetKey: "dataset",
        },
        {
          id: "run-glm",
          runId: "run-2",
          name: "GLM 5.3 · high",
          provider: "openrouter",
          model: "openrouter/z-ai/glm-5.3",
          harness: "codex",
          accuracy: 60,
          cost: 0.05,
          tasks: 4,
          datasetKey: "dataset",
        },
      ]}
      onSelect={() => {}}
    />,
  );
  const chips = [...html.matchAll(/aria-label="Highlight ([^"]+)"/g)].map((match) => match[1]);
  expect(chips).toEqual(["Z.ai", "Custom"]);
});

test("a zero-cost run sits on the log axis's zero tick, and no tick reads over 100%", () => {
  const point = (id: string, accuracy: number, cost: number) => ({
    id,
    runId: id,
    name: id,
    provider: "openai",
    model: "openai/gpt-5.5",
    harness: "codex",
    accuracy,
    cost,
    tasks: 4,
    datasetKey: "dataset",
  });
  const html = renderToStaticMarkup(
    <ParetoChart
      points={[point("free", 100, 0), point("paid", 100, 0.4), point("dear", 100, 2)]}
      onSelect={() => {}}
    />,
  );
  expect(html.match(/class="pareto-point[ "]/g)).toHaveLength(3);
  expect(html).toContain(">$0.00</text>");
  const ticks = [...html.matchAll(/>(\d+(?:\.\d+)?)%<\/text>/g)].map((match) => Number(match[1]));
  expect(ticks.length).toBeGreaterThan(0);
  expect(Math.max(...ticks)).toBeLessThanOrEqual(100);
});
