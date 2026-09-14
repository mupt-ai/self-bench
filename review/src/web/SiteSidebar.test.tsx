import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { SiteSidebar } from "./SiteSidebar";
import type { SiteOrg } from "./session";

function renderSidebar(path: string, kind: SiteOrg["kind"] = "org") {
  const org: SiteOrg = { login: "example-account", kind, role: "admin" };
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <SiteSidebar
        user={{ login: "example-user" }}
        org={org}
        orgs={[org]}
        onSelect={() => {}}
        onSignOut={async () => {}}
      />
    </MemoryRouter>,
  );
}

test("sidebar exposes labeled navigation and credentials", () => {
  const html = renderSidebar("/");
  const links = html.match(/<a[^>]*data-slot="sidebar-menu-button"[^>]*>/g) ?? [];
  expect(links).toHaveLength(2);
  expect(html).toContain('aria-label="Organization Navigation"');
  expect(html).toContain('aria-label="Credentials"');
  expect(html).toContain("Credentials");
  expect(html).toContain('aria-label="self-bench by dari.dev Home"');
  expect(html).toContain("by dari.dev</span>");
});

test("sidebar supports the compact icon mode", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/"]}>
      <SiteSidebar
        user={{ login: "example-user" }}
        org={{ login: "example-account", kind: "org", role: "admin" }}
        orgs={[]}
        onSelect={() => {}}
        onSignOut={async () => {}}
        collapsed
      />
    </MemoryRouter>,
  );
  expect(html).not.toContain(">Repositories</span>");
  expect(html).not.toContain(">Credentials</span>");
});

test("sidebar preserves active navigation across repository and settings routes", () => {
  for (const [path, href] of [
    ["/", "/"],
    ["/repos/example-account/example-repo", "/"],
    ["/settings/credentials", "/settings/credentials"],
  ]) {
    const html = renderSidebar(path);
    const active = html.match(/<a[^>]*data-active="true"[^>]*>/g) ?? [];
    expect(active).toHaveLength(1);
    expect(active[0]).toContain(`href="${href}"`);
  }
});

test("account picker keeps its menu affordance and readable personal account label", () => {
  const html = renderSidebar("/", "user");
  expect(html).toContain('aria-haspopup="menu"');
  expect(html).toContain('aria-label="Organization"');
  expect(html).toContain("cursor-pointer");
  expect(html).toContain("example-account");
});
