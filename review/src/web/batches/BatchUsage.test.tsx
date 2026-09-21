import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunUsageSummary } from "../../../../src/managed/usage";
import { BatchUsage } from "./BatchUsage";

const usage: RunUsageSummary = {
  modelCostUsd: 1.25,
  sandboxCostUsd: 0.08,
  managedCostUsd: 1.33,
  modelTokens: { input: 1200, output: 300, cacheRead: 80, cacheWrite: 20 },
  tokens: 1600,
  sandboxSeconds: 125,
};

test("batch usage separates LLM and sandbox consumption", () => {
  const html = renderToStaticMarkup(<BatchUsage usage={usage} />);
  expect(html).toContain('aria-label="Batch Usage"');
  expect(html).toContain('aria-label="LLM Usage"');
  expect(html).toContain('aria-label="Sandbox Usage"');
  expect(html).toContain("1,600");
  expect(html).toContain("2m 5s");
  expect(html).toContain("$1.25");
  expect(html).toContain("$0.08");
  expect(html).toContain("Provider credentials are billed by their providers");
});

test("batch usage distinguishes unavailable provider cost", () => {
  const html = renderToStaticMarkup(
    <BatchUsage
      usage={{
        ...usage,
        modelCostUsd: undefined,
        sandboxCostUsd: undefined,
      }}
    />,
  );
  expect(html.match(/Not Available/g)).toHaveLength(2);
});
