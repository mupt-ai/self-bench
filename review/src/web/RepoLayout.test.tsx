import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { RepoLayout } from "./RepoLayout";
import { useOrg } from "./SiteLayout";

function PageContent() {
  const { org } = useOrg();
  return <h1>Page content for {org.login}</h1>;
}

for (const section of ["", "/run", "/results", "/settings/credentials", "/comparisons/example"]) {
  test(`repository layout owns one breadcrumb and navigation on ${section || "dataset"}`, () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/repos/mupt-ai/self-bench${section}`]}>
        <Routes>
          <Route element={<Outlet context={{ org: { login: "mupt-ai" }, orgs: [] }} />}>
            <Route path="/repos/:owner/:name" element={<RepoLayout />}>
              <Route index element={<PageContent />} />
              <Route path="*" element={<PageContent />} />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(html.match(/aria-label="Breadcrumb"/g)).toHaveLength(1);
    expect(html.match(/aria-label="Repository Sections"/g)).toHaveLength(1);
    expect(html.match(/<main/g)).toHaveLength(1);
    expect(html).toContain("mupt-ai/self-bench");
    expect(html).toContain("Page content for mupt-ai");
    expect(html).not.toContain('href="/repos/mupt-ai/self-bench/dataset"');
    expect(html.match(/>Dataset<\/a>/g)).toHaveLength(1);
    expect(html).not.toContain(">Review</a>");
  });
}
