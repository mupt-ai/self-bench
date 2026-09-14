import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { LoginPage } from "./pages/LoginPage";
import { RepositoryList } from "./pages/RepositoryList";
import { Button, buttonStyles } from "./ui";

test("standalone button styles retain geometry without overriding Button icon sizing", () => {
  for (const styles of Object.values(buttonStyles)) {
    for (const utility of ["h-10", "px-4", "py-2", "gap-2", "[&>svg]:size-4"])
      expect(styles.split(" ")).toContain(utility);
  }
  const html = renderToStaticMarkup(<Button size="small">Run</Button>);
  expect(html).toContain("h-8 px-3 text-xs");
  expect(html).not.toContain("h-10");
  expect(html).not.toContain("size-4");
});

test("GitHub sign-in retains a padded hit target and bounded icon", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
  const signIn = html.match(/<a[^>]*href="\/auth\/github"[^>]*>/)?.[0];
  expect(signIn).toContain("h-10");
  expect(signIn).toContain("px-4 py-2");
  expect(signIn).toContain("gap-2");
  expect(signIn).toContain("size-4");
});

test("destructive fill and foreground are defined separately from red text", () => {
  const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8");
  expect(theme).toContain("--color-destructive: var(--bad-fg)");
  expect(theme).toContain("--color-destructive-background: var(--bad)");
  expect(theme).toContain("--color-destructive-foreground: hsl(0 0% 98%)");
  expect(buttonStyles.destructive).toContain("bg-destructive-background");
  expect(buttonStyles.destructive).toContain("text-destructive-foreground");
});

test("repository action track accommodates the 40px icon button", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RepositoryList repos={[]} stats={{}} onDisconnect={() => {}} />
    </MemoryRouter>,
  );
  expect(html).toContain("md:grid-cols-[minmax(0,1fr)_5rem_8rem_5rem_2.5rem]");
  const icon = renderToStaticMarkup(<Button size="icon" aria-label="Disconnect" />);
  expect(icon).toContain("h-10 w-10");
});
