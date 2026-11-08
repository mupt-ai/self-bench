import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { RepositoryList } from "./RepositoryList";

const repo = {
  kind: "github" as const,
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
        groups={[]}
        onDisconnect={() => {}}
        onRemoveGroup={() => {}}
        onConnect={() => {}}
        onNewGroup={() => {}}
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
      <RepositoryList
        repos={[]}
        stats={{}}
        groups={[]}
        onDisconnect={() => {}}
        onRemoveGroup={() => {}}
        onConnect={() => {}}
        onNewGroup={() => {}}
      />
    </MemoryRouter>,
  );
  expect(html).toContain('aria-label="Connect a Repository"');
});

test("the Mined Repos list offers a new group next to connecting a repository", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RepositoryList
        repos={[]}
        stats={{}}
        groups={[]}
        onDisconnect={() => {}}
        onRemoveGroup={() => {}}
        onConnect={() => {}}
        onNewGroup={() => {}}
      />
    </MemoryRouter>,
  );
  expect(html).toContain('aria-label="New Group"');
});

test("a group is a card on the list, linking to its own page", () => {
  const removed: string[] = [];
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RepositoryList
        repos={[]}
        stats={{}}
        groups={[
          {
            slug: "python-web",
            name: "Python Web",
            description: "",
            repositories: [{ id: 1, fullName: "example/api", connected: false, tasks: 3 }],
            tasks: 3,
            updatedAt: "2026-09-18T00:00:00.000Z",
            updatedBy: "example",
          },
        ]}
        onDisconnect={() => {}}
        onRemoveGroup={(group) => removed.push(group.slug)}
        onConnect={() => {}}
        onNewGroup={() => {}}
      />
    </MemoryRouter>,
  );
  expect(html).toContain('href="/groups/python-web"');
  expect(html).toContain("Python Web");
  expect(html).toContain("Disconnected");
  expect(removed).toEqual([]);
});
