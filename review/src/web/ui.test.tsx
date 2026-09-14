import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, controlStyles } from "./ui";

test("small and icon buttons override the shared default dimensions", () => {
  const small = renderToStaticMarkup(<Button size="small">Small</Button>);
  expect(small).toContain("h-8");
  expect(small).not.toContain("h-9");
  const icon = renderToStaticMarkup(<Button size="icon" aria-label="Close" />);
  expect(icon).toContain("w-9");
});

test("form controls use text-base on mobile so iOS does not zoom on focus", () => {
  const classes = controlStyles.split(" ");
  expect(classes).toContain("text-base");
  expect(classes).toContain("md:text-sm");
  expect(classes).not.toContain("text-sm");
});
