import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ParetoChart } from "./ParetoChart";

test("Pareto charts use mint instead of the yellow brand accent", () => {
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
      ]}
      onSelect={() => {}}
    />,
  );
  expect(html).toContain("[--pareto-frontier:#8ee6bd]");
  expect(html).not.toContain("var(--brand)");
  expect(html).not.toContain("Accuracy vs. Estimated Cost");
  expect(html).not.toContain("same dataset");
  expect(html).toContain("[&amp;_polyline]:[stroke-width:1]");
  expect(html).toContain("[&amp;_polyline]:opacity-50");
  expect(html).toContain("text-[18px]");
  expect(html).toContain('height="468"');
  expect(html).toContain(">Model</text>");
  expect(html).toContain("[&amp;_circle[role=&#x27;button&#x27;][r=&#x27;8&#x27;]]:[r:5]");
  expect(html).toContain(
    "[&amp;_circle[role=&#x27;button&#x27;][r=&#x27;8&#x27;]]:stroke-[#8ee6bd]",
  );
  expect(html).not.toContain("drop-shadow");
});
