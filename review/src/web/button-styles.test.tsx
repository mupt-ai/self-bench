import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, buttonStyles } from "./ui";

test("standalone button styles retain geometry without overriding Button icon sizing", () => {
  for (const styles of Object.values(buttonStyles)) {
    for (const utility of ["h-9", "px-3", "py-2", "gap-2", "[&>svg]:size-4"])
      expect(styles.split(" ")).toContain(utility);
  }
  const html = renderToStaticMarkup(<Button size="small">Run</Button>);
  expect(html).toContain("h-8 px-3 text-xs");
  expect(html).not.toContain("h-9");
  expect(html).not.toContain("size-4");
  expect(renderToStaticMarkup(<Button size="icon" aria-label="Close" />)).toContain("h-9 w-9");
});

test("destructive fill and foreground are defined separately from red text", () => {
  const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8");
  expect(theme).toContain("--color-destructive: var(--bad-fg)");
  expect(theme).toContain("--color-destructive-background: var(--bad)");
  expect(theme).toContain("--color-destructive-foreground: hsl(0 0% 98%)");
  expect(buttonStyles.destructive).toContain("bg-destructive-background");
  expect(buttonStyles.destructive).toContain("text-destructive-foreground");
});
