import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { RepositoryList } from "./RepositoryList";

const repo = {
  fullName: "example/repo",
  defaultBranch: "main",
  private: false,
  continuous: false,
  connectedBy: "example",
  connectedAt: "2026-09-18T00:00:00.000Z",
};

test("connected repositories link to their page with task stats beside the connect card", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RepositoryList
        repos={[repo]}
        stats={{ "example/repo": { tasks: 4, needsReview: 2, lastPr: 18 } }}
        onDisconnect={() => {}}
        onConnect={() => {}}
      />
    </MemoryRouter>,
  );
  expect(html).toContain('href="/repos/example/repo"');
  expect(html).toContain('aria-label="Open example/repo"');
  expect(html).toContain("example/repo");
  expect(html).toContain("Tasks");
  expect(html).toContain("Needs Review");
  expect(html).toContain("Last PR");
  expect(html).toContain("#18");
  expect(html).toContain('aria-label="Actions for example/repo"');
  expect(html).toContain('aria-label="Connect a Repository"');
});

test("an empty list still offers the connect card", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RepositoryList repos={[]} stats={{}} onDisconnect={() => {}} onConnect={() => {}} />
    </MemoryRouter>,
  );
  expect(html).toContain('aria-label="Connect a Repository"');
});
