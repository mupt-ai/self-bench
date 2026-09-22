import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BillingUsage } from "./BillingUsage";

const usage = {
  modelTokens: { input: 1200, output: 300, cacheRead: 80, cacheWrite: 20 },
  tokens: 1600,
  modelBillableUsd: 1.25,
  sandboxSeconds: 125,
  sandboxBillableUsd: 0.08,
};

test("billing usage visualizes model and sandbox consumption", () => {
  const html = renderToStaticMarkup(<BillingUsage usage={usage} />);
  expect(html).toContain('aria-labelledby="recorded-usage-title"');
  expect(html).toContain('aria-label="Model Usage"');
  expect(html).toContain('aria-label="Sandbox Usage"');
  expect(html).toContain("All Time");
  expect(html).toContain("1,600");
  expect(html).toContain("2m 5s");
  expect(html).toContain("$1.25");
  expect(html).toContain("$0.08");
  expect(html).toContain("Cache Read");
  expect(html).toContain("Share of Recorded Cost");
  expect(html).toContain('role="img"');
});

test("billing usage has a clear zero-data state", () => {
  const html = renderToStaticMarkup(
    <BillingUsage
      usage={{
        modelTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        tokens: 0,
        modelBillableUsd: 0,
        sandboxSeconds: 0,
        sandboxBillableUsd: 0,
      }}
    />,
  );
  expect(html).toContain("No Managed Usage Yet");
  expect(html).toContain("after the first managed run");
  expect(html).not.toContain('aria-label="Model Usage"');
});
