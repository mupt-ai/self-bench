import { expect, test } from "bun:test";
import { buttonStyles } from "../web/ui";
import { viewerIconButton } from "./viewer-ui";

test("viewer icon button replaces padded geometry instead of stacking size utilities", () => {
  const classes = viewerIconButton.split(" ");
  expect(classes).toContain("size-9");
  expect(classes).toContain("p-0");
  expect(classes).not.toContain("h-9");
  expect(classes).not.toContain("px-3");
  expect(classes).not.toContain("py-2");
  expect(buttonStyles.secondary.split(" ")).toContain("h-9");
});
