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

test("billing usage makes model and sandbox consumption visible", () => {
  const html = renderToStaticMarkup(<BillingUsage usage={usage} />);
  expect(html).toContain('aria-label="Recorded Usage"');
  expect(html).toContain('aria-label="LLM Usage"');
  expect(html).toContain('aria-label="Sandbox Usage"');
  expect(html).toContain("All Time");
  expect(html).toContain("1,600");
  expect(html).toContain("2m 5s");
  expect(html).toContain("$1.25");
  expect(html).toContain("$0.080");
  expect(html.match(/Billable Amount/g)).toHaveLength(2);
  expect(html).toContain("frozen rate recorded with each managed usage event");
  expect(html).not.toContain("estimates");
});
