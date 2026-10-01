import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { SiteSidebar } from "./SiteSidebar";
import type { SiteOrg } from "./session";

function renderSidebar(
  path: string,
  kind: SiteOrg["kind"] = "org",
  billing = true,
  getStarted = false,
) {
  const org: SiteOrg = { login: "example-account", kind, role: "admin" };
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <SiteSidebar
        user={{ githubId: 1, login: "example-user" }}
        org={org}
        orgs={[org]}
        onSelect={() => {}}
        onSignOut={async () => {}}
        billing={billing}
        getStarted={getStarted}
      />
    </MemoryRouter>,
  );
}

test("sidebar exposes labeled navigation and credentials", () => {
  const html = renderSidebar("/");
  const links = html.match(/<a[^>]*data-slot="sidebar-menu-button"[^>]*>/g) ?? [];
  expect(links).toHaveLength(4);
  expect(html).toContain('aria-label="Organization Navigation"');
  expect(html).toContain('aria-label="Credentials"');
  expect(html).toContain("Credentials");
  expect(html).toContain('aria-label="API Keys"');
  expect(html).toContain(">API Keys</span>");
  expect(html).toContain('aria-label="Billing"');
  expect(html).toContain(">Billing</span>");
  expect(html).toContain('aria-label="self-bench by dari.dev Home"');
  expect(html).toContain("by dari.dev</span>");
});

test("sidebar leaves out Billing without the managed offering", () => {
  const html = renderSidebar("/", "org", false);
  expect(html.match(/<a[^>]*data-slot="sidebar-menu-button"[^>]*>/g) ?? []).toHaveLength(3);
  expect(html).not.toContain("Billing");
});

test("sidebar offers Get Started until the org can generate and evaluate", () => {
  expect(renderSidebar("/", "org", false, true)).toContain('href="/get-started"');
  expect(renderSidebar("/", "org", false, false)).not.toContain("Get Started");
  // Finishing setup on the page itself keeps the entry for the page being viewed.
  const html = renderSidebar("/get-started", "org", false, false);
  expect(html.match(/<a[^>]*data-active="true"[^>]*>/g)?.[0]).toContain('href="/get-started"');
});

test("sidebar supports the compact icon mode", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/"]}>
      <SiteSidebar
        user={{ githubId: 1, login: "example-user" }}
        org={{ login: "example-account", kind: "org", role: "admin" }}
        orgs={[]}
        onSelect={() => {}}
        onSignOut={async () => {}}
        billing
        getStarted={false}
        collapsed
      />
    </MemoryRouter>,
  );
  expect(html).not.toContain(">Repositories</span>");
  expect(html).not.toContain(">Credentials</span>");
  expect(html).not.toContain(">API Keys</span>");
  expect(html).not.toContain(">Billing</span>");
});

test("sidebar preserves active navigation across repository and settings routes", () => {
  for (const [path, href] of [
    ["/", "/"],
    ["/repos/example-account/example-repo", "/"],
    ["/settings/credentials", "/settings/credentials"],
    ["/settings/api-keys", "/settings/api-keys"],
    ["/settings/billing", "/settings/billing"],
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
  expect(html).toContain("example-account");
});
