import { expect, test } from "bun:test";
import { controlStyles } from "./ui";

test("form controls use text-base on mobile so iOS does not zoom on focus", () => {
  const classes = controlStyles.split(" ");
  expect(classes).toContain("text-base");
  expect(classes).toContain("md:text-sm");
  expect(classes).not.toContain("text-sm");
});
