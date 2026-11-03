import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { SiteSidebar } from "./SiteSidebar";
import type { SiteOrg } from "./session";

function renderSidebar(
  path: string,
  kind: SiteOrg["kind"] = "org",
  billing = true,
  onSetup?: () => void,
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
        onSetup={onSetup}
      />
    </MemoryRouter>,
  );
}

test("sidebar exposes labeled navigation and credentials", () => {
  const html = renderSidebar("/");
  const links = html.match(/<a[^>]*data-slot="sidebar-menu-button"[^>]*>/g) ?? [];
  expect(links).toHaveLength(7);
  expect(html).toContain('aria-label="Organization Navigation"');
  expect(html).toContain('aria-label="Public Benchmarks"');
  expect(html).toContain(">Public Benchmarks</span>");
  expect(html).toContain('aria-label="Credentials"');
  expect(html).toContain("Credentials");
  expect(html).toContain('aria-label="API Keys"');
  expect(html).toContain(">API Keys</span>");
  expect(html).toContain('aria-label="Billing"');
  expect(html).toContain(">Billing</span>");
  expect(html).toMatch(
    /<a[^>]*href="https:\/\/docs\.selfbench\.dev"[^>]*target="_blank"[^>]*aria-label="Docs"/,
  );
  expect(html).toContain('aria-label="self-bench by dari.dev Home"');
  expect(html).toContain("by dari.dev</span>");
});

test("sidebar sorts its pages into named sections, in order", () => {
  const html = renderSidebar("/");
  const order = ["Evaluate", "Repositories", "Repository Groups", "Public Benchmarks"]
    .concat(["Organization", "Credentials", "API Keys", "Billing"])
    .map((label) => html.indexOf(`>${label}</`));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((left, right) => left - right));
  // Each section is a group named by its heading, so a screen reader announces where it is.
  for (const section of ["Evaluate", "Organization"])
    expect(html).toContain(`aria-labelledby="sidebar-section-${section.toLowerCase()}"`);
});

test("sidebar leaves out Billing without the managed offering", () => {
  const html = renderSidebar("/", "org", false);
  expect(html.match(/<a[^>]*data-slot="sidebar-menu-button"[^>]*>/g) ?? []).toHaveLength(6);
  expect(html).not.toContain("Billing");
});

test("sidebar offers Finish Setup while the org still needs setup", () => {
  expect(renderSidebar("/", "org", false, () => {})).toContain('aria-label="Finish Setup"');
  expect(renderSidebar("/", "org", false)).not.toContain("Finish Setup");
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
        collapsed
      />
    </MemoryRouter>,
  );
  expect(html).not.toContain(">Repositories</span>");
  expect(html).not.toContain(">Credentials</span>");
  expect(html).not.toContain(">API Keys</span>");
  expect(html).not.toContain(">Billing</span>");
  // Section names give way to rules, but each group keeps its name for screen readers.
  expect(html).not.toContain(">Evaluate</h2>");
  expect(html).toContain('aria-label="Organization"');
});

test("sidebar preserves active navigation across repository and settings routes", () => {
  for (const [path, href] of [
    ["/", "/"],
    ["/repos/example-account/example-repo", "/"],
    ["/settings/credentials", "/settings/credentials"],
    ["/settings/api-keys", "/settings/api-keys"],
    ["/settings/billing", "/settings/billing"],
    ["/groups", "/groups"],
    ["/groups/python-web/results", "/groups"],
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
