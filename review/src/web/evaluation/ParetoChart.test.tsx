import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ParetoChart } from "./ParetoChart";

test("Pareto charts rely on the package defaults and only map app theme tokens", () => {
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
  expect(html).toContain("[--pareto-background:var(--card)]");
  expect(html).toContain("[--pareto-font-family:var(--mono)]");
  expect(html).toContain("[--pareto-frontier:var(--foreground)]");
  expect(html).not.toContain("var(--brand)");
  expect(html).not.toContain("[&amp;_polyline]");
  expect(html).not.toContain("[&amp;_circle");
  // Title-size override ships so chart text reads at app scale.
  expect(html).toContain("[&amp;&gt;text[font-size=&#x27;14&#x27;]]:text-[17px]");
  expect(html).toContain(">Model Comparison</text>");
  expect(html).not.toContain("Accuracy vs. Estimated Cost");
  expect(html).not.toContain("Accuracy versus Cost per Task");
  expect(html).not.toContain("same dataset");
  expect(html).toContain('height="520"');
  expect(html).not.toContain("Estimated token cost");
  expect(html).not.toContain("<footer");
  expect(html).toContain(">Model</text>");
  // Quiet dashed frontier and mint hover ship with dari-pareto >= 0.2.0.
  expect(html).toContain('stroke-dasharray="4 5"');
  expect(html).toContain(".pareto-point:hover circle");
});
