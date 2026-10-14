import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { BenchmarkRunPage } from "./BenchmarkRunPage";
import { restoreBenchmarkDraft } from "./run-draft";
import { BenchmarkScope } from "./useEvaluationScope";

const url = "/api/orgs/team/benchmarks/terminal-bench/terminal-bench-2/evaluations";
const key = `selfbench-run:${url}`;

test("benchmark drafts keep their models, and a broken one starts fresh", () => {
  const fresh = restoreBenchmarkDraft(null);
  const model = { catalogId: "gpt", credentialId: "model", harnesses: ["codex" as const] };
  const saved = { ...fresh, draft: { ...fresh.draft, models: [model] } };
  expect(restoreBenchmarkDraft(JSON.stringify(saved)).draft).toEqual(saved.draft);
  const broken = { ...saved, draft: { ...saved.draft, sandbox: "nowhere" } };
  expect(restoreBenchmarkDraft(JSON.stringify(broken)).draft.id).not.toBe(fresh.draft.id);
});

test("a benchmark's Run page runs its dataset and offers no repository tasks", async () => {
  const browser = new Window({ url: "https://selfbench.test" });
  const globals = {
    window: browser,
    document: browser.document,
    sessionStorage: browser.sessionStorage,
    HTMLElement: browser.HTMLElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const container = document.createElement("div");
  document.body.append(container);
  const requests: string[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input) => {
    const endpoint = String(input);
    requests.push(endpoint);
    if (endpoint === `${url}/catalog`)
      return Response.json({
        models: [],
        sandboxes: ["e2b"],
        managed: { models: false, sandbox: false },
      });
    if (endpoint === "/api/orgs/team/benchmarks/terminal-bench/terminal-bench-2")
      return Response.json({
        benchmark: { id: 1, name: "terminal-bench/terminal-bench-2", ref: "latest", tasks: 89 },
      });
    if (endpoint === "/api/orgs/team/credentials")
      return Response.json({
        credentials: [
          { id: "model", name: "OpenAI", kind: "openai", auth: "api-key", createdAt: "" },
          { id: "sandbox", name: "E2B", kind: "e2b", auth: "api-key", createdAt: "" },
        ],
      });
    throw new Error(`Unexpected request: ${endpoint}`);
  }) as typeof globalThis.fetch);
  const page = (
    <MemoryRouter initialEntries={["/benchmarks/terminal-bench/terminal-bench-2/run"]}>
      <Routes>
        <Route element={<Outlet context={{ org: { login: "team" }, orgs: [] }} />}>
          <Route
            path="/benchmarks/:owner/:name/run"
            element={
              <BenchmarkScope>
                <BenchmarkRunPage />
              </BenchmarkScope>
            }
          />
        </Route>
      </Routes>
    </MemoryRouter>
  );
  let root = createRoot(container);
  try {
    await act(async () => root.render(page));
    expect(container.querySelector("h1")?.textContent).toBe("Run");
    expect(container.textContent).toContain(
      "terminal-bench/terminal-bench-2 from Harbor's registry",
    );
    expect(container.textContent).not.toContain("Accepted Task");
    expect(requests.some((endpoint) => endpoint.includes("/options"))).toBe(false);
    expect(container.textContent).toContain("Add a model to continue.");
    // The dataset's tasks, as counted when it was added.
    const tasks = [...container.querySelectorAll("dt")].find(
      (term) => term.textContent === "Tasks",
    );
    expect(tasks?.nextElementSibling?.textContent).toBe("89");

    // A saved draft for this benchmark comes back.
    await act(async () => root.unmount());
    const fresh = restoreBenchmarkDraft(null);
    browser.sessionStorage.setItem(key, JSON.stringify({ ...fresh, sandboxDefaultPending: false }));
    root = createRoot(container);
    await act(async () => root.render(page));
    expect(JSON.parse(browser.sessionStorage.getItem(key) ?? "null").draft.id).toBe(fresh.draft.id);
    await act(async () => root.unmount());
  } finally {
    fetch.mockRestore();
    container.remove();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await browser.happyDOM.close();
  }
});
