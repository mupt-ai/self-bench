import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { ReposPage } from "./ReposPage";

test("repository header actions match Dari's small buttons and spaced 16px icons", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <Routes>
        <Route element={<Outlet context={{ org: { login: "example" }, orgs: [] }} />}>
          <Route index element={<ReposPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  const buttons = html.match(/<button[^>]*>/g) ?? [];
  expect(buttons).toHaveLength(2);
  for (const button of buttons) {
    expect(button).toContain("h-8 px-3 text-xs");
    expect(button).not.toContain("h-10");
  }
  expect(html.match(/mr-1 h-4 w-4/g)).toHaveLength(2);
  expect(html).toContain("sm:items-start");
  expect(html).toContain("mt-1 text-sm text-muted-foreground");
});
