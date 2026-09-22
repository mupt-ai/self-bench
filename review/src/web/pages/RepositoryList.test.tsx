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

test("connected repositories render as info cards instead of a table", () => {
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
  expect(html).toContain("grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3");
  expect(html).toContain("panel");
  expect(html).toContain('href="/repos/example/repo"');
  expect(html).toContain('aria-label="Open example/repo"');
  expect(html).toContain("example/repo");
  expect(html).toContain("Tasks");
  expect(html).toContain("Needs Review");
  expect(html).toContain("Last PR");
  expect(html).toContain("#18");
  expect(html).toContain('aria-label="Actions for example/repo"');
  expect(html).not.toContain("Unplug");
  expect(html).not.toContain("md:grid-cols-[minmax(0,1fr)_5rem_8rem_5rem_2.5rem]");
  expect(html).toContain("border-dashed");
  expect(html).toContain('aria-label="Connect a Repository"');
  expect(html).toContain("Connect a Repository");
});

test("an empty list still offers a dashed connect card instead of a banner", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RepositoryList repos={[]} stats={{}} onDisconnect={() => {}} onConnect={() => {}} />
    </MemoryRouter>,
  );
  expect(html).toContain("border-dashed");
  expect(html).toContain('aria-label="Connect a Repository"');
  expect(html).not.toContain("Connect a Repository to Get Started");
  expect(html).not.toContain("Connect My Repo");
});
