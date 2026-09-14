import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./ui";

test("small and icon buttons override the shared default dimensions", () => {
  const small = renderToStaticMarkup(<Button size="small">Small</Button>);
  expect(small).toContain("h-8");
  expect(small).not.toContain("h-9");
  const icon = renderToStaticMarkup(<Button size="icon" aria-label="Close" />);
  expect(icon).toContain("w-9");
});
