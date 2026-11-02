import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import type { OrgContext } from "../SiteLayout";
import type { GroupList, GroupSummary } from "./api";
import { GroupsPage } from "./GroupsPage";

const url = "/api/orgs/acme/release-groups";
const candidate = (id: number, fullName: string, settingIds: string[]) => ({
  id,
  fullName,
  releasedAt: "2026-10-01T00:00:00.000Z",
  tasks: 10,
  settingIds,
});

let browser: Window;
let root: Root;
let container: HTMLDivElement;
let restoreGlobals: () => void;
let restoreFetch: () => void;
let requests: { method: string; path: string; body?: unknown }[];
let list: GroupList;

beforeEach(async () => {
  browser = new Window({ url: "https://selfbench.test/groups" });
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
  restoreGlobals = () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
  requests = [];
  list = {
    groups: [],
    candidates: [
      candidate(1, "pallets/flask", ["sol", "luna"]),
      candidate(2, "django/django", ["sol"]),
      candidate(3, "encode/starlette", ["terra"]),
    ],
    resultsSiteUrl: "https://selfbench.example",
  };
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, body });
    if (method === "GET" && path === url) return Response.json(list);
    if (method === "POST" && path === url) {
      const saved: GroupSummary = {
        id: "00000000-0000-0000-0000-000000000001",
        ...body,
        publicUrl: `https://selfbench.example/groups/acme/${body.slug}`,
        repositories: body.repositoryIds.map((id: number) => ({
          id,
          fullName: list.candidates.find((each) => each.id === id)?.fullName,
          released: true,
        })),
        updatedAt: "2026-10-02T00:00:00.000Z",
        updatedBy: "priya",
      };
      list = { ...list, groups: [saved] };
      return Response.json({ group: saved }, { status: 201 });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  }) as typeof globalThis.fetch);
  restoreFetch = () => fetch.mockRestore();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const context: OrgContext = {
    org: { login: "acme", kind: "org", role: "admin" },
    orgs: [],
  };
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/groups"]}>
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route path="groups" element={<GroupsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  restoreFetch();
  restoreGlobals();
  await browser.happyDOM.close();
});

const text = () => container.textContent ?? "";
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (item) => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!predicate() && Date.now() < deadline)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
  expect(predicate()).toBe(true);
}
/** The field a label names; its text is the label's first line. */
function field(label: string): HTMLInputElement {
  const found = [...container.querySelectorAll("label")].find((item) =>
    item.textContent?.startsWith(label),
  );
  const input = found?.querySelector<HTMLInputElement>("input, textarea");
  if (!input) throw new Error(`Missing field: ${label}`);
  return input;
}
/**
 * react-dom decides at import time whether `input` events exist; the DOM is installed later in
 * these tests, so React falls back to its legacy change detection, which watches the focused
 * element (via `attachEvent`) and compares its value on `keyup`.
 */
async function type(input: HTMLInputElement, value: string) {
  Object.assign(input, { attachEvent() {}, detachEvent() {} });
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  const event = (name: string) => new browser.Event(name, { bubbles: true }) as unknown as Event;
  await act(async () => input.dispatchEvent(event("focusin")));
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(event("keyup"));
  });
}
async function tick(fullName: string) {
  const row = [...container.querySelectorAll("label")].find((item) =>
    item.textContent?.includes(fullName),
  );
  const box = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!box) throw new Error(`Missing repository: ${fullName}`);
  await act(async () => box.click());
}

test("releases a group of released repositories, counting what the page will pool", async () => {
  await waitFor(() => text().includes("No Groups Yet"));
  await act(async () => button("New Group").click());
  const release = button("Release Group");
  expect(release.disabled).toBe(true);

  await type(field("Name"), "Python Web Frameworks");
  // The address follows the name until it is typed in.
  expect(field("Address").value).toBe("python-web-frameworks");
  expect(text()).toContain("https://selfbench.example/groups/acme/python-web-frameworks");

  await tick("pallets/flask");
  expect(text()).toContain("Choose at least two repositories.");
  await tick("encode/starlette");
  expect(text()).toContain("share no released setting");
  await tick("encode/starlette");
  await tick("django/django");
  expect(text()).toContain("The page will score 1 setting over 20 tasks from 2 repositories.");
  // The order the page lists them in is the order they were ticked, and can be changed.
  await act(async () => button("Move django/django Up").click());
  expect(release.disabled).toBe(false);

  await act(async () => release.click());
  await waitFor(() => text().includes("Released Python Web Frameworks."));
  expect(requests.find((each) => each.method === "POST")?.body).toEqual({
    name: "Python Web Frameworks",
    slug: "python-web-frameworks",
    description: "",
    repositoryIds: [2, 1],
  });
  await waitFor(() => text().includes("django/django, pallets/flask"));
  const link = container.querySelector<HTMLAnchorElement>(
    'a[href$="/groups/acme/python-web-frameworks"]',
  );
  expect(link?.textContent).toContain("View Public Page");
});
