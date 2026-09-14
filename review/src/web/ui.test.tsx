import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, buttonStyles } from "./ui";

test("button links carry the same dimensions and icon sizing as buttons", () => {
  for (const style of Object.values(buttonStyles)) {
    expect(style.split(" ")).toContain("h-9");
    expect(style.split(" ")).toContain("px-3");
    expect(style.split(" ")).toContain("gap-2");
    expect(style).toContain("[&>svg]:size-4");
  }
});

test("small and icon buttons override the shared default dimensions", () => {
  const small = renderToStaticMarkup(<Button size="small">Small</Button>);
  expect(small).toContain("h-8");
  expect(small).not.toContain("h-9");
  const icon = renderToStaticMarkup(<Button size="icon" aria-label="Close" />);
  expect(icon).toContain("w-9");
});
