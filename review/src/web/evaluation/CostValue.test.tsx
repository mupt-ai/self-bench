import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CostValue } from "./CostValue";

test("incomplete costs use a compact accessible tooltip trigger, not a long inline label", () => {
  const html = renderToStaticMarkup(<CostValue value={1.03} incomplete />);
  expect(html).toContain("$1.03");
  expect(html).toContain('aria-label="Incomplete Cost"');
  expect(html).not.toContain("(Incomplete)");
});

test("complete costs have no warning trigger", () => {
  const html = renderToStaticMarkup(<CostValue value={1.03} />);
  expect(html).toContain("$1.03");
  expect(html).not.toContain("button");
});
