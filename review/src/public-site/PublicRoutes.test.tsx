import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { PublicRoutes } from "./PublicRoutes";
import { memorySource } from "./source";
import { SourceContext } from "./source-context";

function render(path: string): string {
  return renderToStaticMarkup(
    <SourceContext.Provider value={memorySource([])}>
      <MemoryRouter initialEntries={[path]}>
        <PublicRoutes />
      </MemoryRouter>
    </SourceContext.Provider>,
  );
}

test("the frame names the site, links sign-in to the app, and marks outgoing links", () => {
  const html = render("/");
  expect(html).toContain(">SELF-BENCH<");
  expect(html).toContain('target="_blank"');
  expect(html).toContain('href="https://app.selfbench.dev"');
  expect(html).toContain(">Sign In<");
  expect(html).toContain("Find the best models for your repo");
  expect(html).toContain('aria-label="Switch to Dark Theme"');
});

test("repository URLs mirror GitHub, dotted names included", () => {
  // Static rendering stops at the loading state; what matters is that the route matched.
  for (const path of ["/vercel/next.js", "/vercel/next.js/acme-labs"]) {
    const html = render(path);
    expect(html).toContain("Loading…");
    expect(html).not.toContain("Find the best models for your repo");
  }
});

test("unknown paths render the frame and nothing else while the client redirects home", () => {
  // <Navigate> only acts in the browser, so a static render shows the empty frame.
  const html = render("/nothing/here/at/all");
  expect(html).toContain(">SELF-BENCH<");
  expect(html).not.toContain("Results appear here");
  expect(html).not.toContain("<h1");
});
