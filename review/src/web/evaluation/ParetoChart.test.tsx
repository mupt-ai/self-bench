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
