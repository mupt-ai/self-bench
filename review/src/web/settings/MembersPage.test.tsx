import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import type { SiteOrg } from "../session";
import { MembersPage } from "./MembersPage";

const base = "/api/orgs/team";
const members = [
  { login: "ada", role: "admin", source: "github" },
  { login: "grace", name: "Grace", role: "member", source: "invite" },
];

let browser: Window;
let root: Root;
let container: HTMLDivElement;
let restore: () => void;
let requests: string[];
let invites: { id: number; githubLogin: string; role: string; createdAt: string }[];

beforeEach(() => {
  browser = new Window({ url: "https://selfbench.test" });
  const globals = {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    navigator: browser.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  requests = [];
  invites = [{ id: 7, githubLogin: "linus", role: "member", createdAt: "2026-11-11T00:00:00Z" }];
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${path}`);
    if (path === `${base}/members`)
      return Response.json({
        members,
        github: [{ githubId: 1, login: "team-gh", kind: "org" }],
        canManage: true,
      });
    if (path === `${base}/invites`) return Response.json({ invites });
    if (method === "POST" && path === `${base}/invites/7/delete`) {
      invites = [];
      return Response.json({ deleted: true });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  }) as typeof globalThis.fetch);
  restore = () => {
    fetch.mockRestore();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  restore();
  await browser.happyDOM.close();
});

async function render(org: SiteOrg) {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/settings/members"]}>
        <Routes>
          <Route element={<Outlet context={{ org, orgs: [org] }} />}>
            <Route path="/settings/members" element={<MembersPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    ),
  );
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!predicate() && Date.now() < deadline)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
  expect(predicate()).toBe(true);
}
const labelled = (label: string) => container.querySelector(`[aria-label="${label}"]`);

test("an admin sees members, connections, and invites, and removes only invited people", async () => {
  await render({ login: "team", kind: "org", role: "admin" });
  await waitFor(() => container.textContent?.includes("grace") ?? false);
  expect(container.textContent).toContain("team-gh");
  expect(labelled("Remove grace")).not.toBeNull();
  // A member from a connected GitHub organization leaves through GitHub.
  expect(labelled("Remove ada")).toBeNull();
  expect(labelled("Role for ada")).not.toBeNull();

  await waitFor(() => labelled("Revoke invite for linus") !== null);
  await act(async () => (labelled("Revoke invite for linus") as HTMLButtonElement).click());
  await waitFor(() => container.textContent?.includes("No Pending Invites") ?? false);
  expect(requests).toContain(`POST ${base}/invites/7/delete`);
  expect(container.textContent).toContain("Invite for linus revoked.");
});

test("a personal workspace has no invites or GitHub organizations", async () => {
  await render({ login: "team", kind: "user", role: "admin" });
  await waitFor(() => container.textContent?.includes("grace") ?? false);
  expect(container.textContent).not.toContain("GitHub Organizations");
  expect(labelled("GitHub Username")).toBeNull();
  expect(labelled("Remove grace")).toBeNull();
  expect(requests).not.toContain(`GET ${base}/invites`);
});
