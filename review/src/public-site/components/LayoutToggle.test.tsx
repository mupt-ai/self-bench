import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LayoutToggle, readResultsLayout } from "./LayoutToggle";

test("the switch marks the current layout, and shows only on a wide window", () => {
  const html = renderToStaticMarkup(<LayoutToggle layout="side" onChange={() => {}} />);
  expect(html).toContain('aria-pressed="false" aria-label="Stacked Layout"');
  expect(html).toContain('aria-pressed="true" aria-label="Side-by-Side Layout"');
  expect(html).toContain("hidden");
  expect(html).toContain("min-[90rem]:inline-flex");
});

test("with nothing remembered, the page starts stacked", () => {
  expect(readResultsLayout()).toBe("stacked");
});
