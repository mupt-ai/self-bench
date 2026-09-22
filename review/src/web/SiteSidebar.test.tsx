import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { SidebarTrigger } from "./primitives/sidebar";
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
  expect(html).toContain("cursor-pointer");
  expect(html).toContain("example-account");
});

test("sidebar preserves group spacing and a neutral active state", () => {
  const html = renderSidebar("/");
  expect(html).toContain('data-slot="sidebar-group"');
  expect(html).toContain('data-slot="sidebar-group-content"');
  const active = html.match(/<a[^>]*data-active="true"[^>]*>/)?.[0];
  expect(active).toContain("data-[active=true]:bg-foreground/[0.07]");
  expect(active).not.toContain("text-brand");
  expect(html).toContain("group-data-[collapsible=icon]/sidebar:p-2");
});

test("org picker uses the compact row while preserving the requested avatar", () => {
  const html = renderSidebar("/");
  const trigger = html.match(/<button[^>]*aria-label="Organization"[^>]*>/)?.[0];
  expect(trigger).toContain("h-10");
  expect(trigger).toContain("border-foreground/15");
  expect(trigger).not.toContain("min-h-14");
  expect(html).toContain("width:20px;height:20px");
});

test("sidebar trigger keeps a 32px button and native 24px PanelLeft icon", () => {
  const html = renderToStaticMarkup(<SidebarTrigger aria-label="Collapse Sidebar" />);
  expect(html).toContain("h-8 w-8");
  expect(html).toContain('width="24"');
  expect(html).toContain('height="24"');
  expect(html).toContain('stroke-width="1.5"');
  expect(html).not.toContain("size-4");
});
