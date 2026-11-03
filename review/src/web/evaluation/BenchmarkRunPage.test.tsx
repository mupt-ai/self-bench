import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { RepoRunsProvider } from "./RepoRuns";
import { RunPage } from "./RunPage";
import { restoreRunDraft } from "./run-draft";
import { BenchmarkScope } from "./useEvaluationScope";

const url = "/api/orgs/team/benchmarks/terminal-bench/terminal-bench-2/evaluations";
const key = `selfbench-run:${url}`;

test("a draft saved before benchmarks picked tasks keeps its models and picks every task", () => {
  const model = { catalogId: "gpt", credentialId: "model", harnesses: ["codex" as const] };
  const { tasks: _, ...older } = restoreRunDraft(null, null).draft;
  const saved = { submitted: false, draft: { ...older, models: [model] } };
  expect(restoreRunDraft(JSON.stringify(saved), null).draft).toEqual({
    ...saved.draft,
    tasks: [],
  });
});

test("a benchmark's Run page is a repository's: it picks tasks and asks for a judge", async () => {
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
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input) => {
    const endpoint = String(input);
    if (endpoint === `${url}/catalog`)
      return Response.json({
        models: [],
        sandboxes: ["e2b"],
        managed: { models: false, sandbox: false },
      });
    if (endpoint === `${url}/options`)
      return Response.json({
        tasks: [
          { runId: "harbor:sha256:a", taskId: "terminal-bench/fix-git" },
          { runId: "harbor:sha256:b", taskId: "terminal-bench/build" },
        ],
        judge: { variables: ["ANTHROPIC_API_KEY"], required: ["ANTHROPIC_API_KEY"] },
      });
    if (endpoint === "/api/orgs/team/credentials")
      return Response.json({
        credentials: [
          { id: "model", name: "OpenAI", kind: "openai", auth: "api-key", createdAt: "" },
          { id: "sandbox", name: "E2B", kind: "e2b", auth: "api-key", createdAt: "" },
        ],
      });
    if (endpoint === url) return Response.json({ runs: [] });
    throw new Error(`Unexpected request: ${endpoint}`);
  }) as typeof globalThis.fetch);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/benchmarks/terminal-bench/terminal-bench-2/run"]}>
          <Routes>
            <Route element={<Outlet context={{ org: { login: "team" }, orgs: [] }} />}>
              <Route
                path="/benchmarks/:owner/:name/run"
                element={
                  <BenchmarkScope>
                    <RepoRunsProvider org="team" url={url}>
                      <RunPage />
                    </RepoRunsProvider>
                  </BenchmarkScope>
                }
              />
            </Route>
          </Routes>
        </MemoryRouter>,
      ),
    );
    expect(container.querySelector("h1")?.textContent).toBe("Run");
    expect(container.textContent).toContain(
      "terminal-bench/terminal-bench-2 from Harbor's registry",
    );
    // Every task of the dataset starts picked, and none is called accepted.
    expect(container.textContent).toContain("2 Tasks");
    expect(container.textContent).not.toContain("Accepted Task");
    expect(
      container.querySelector('a[href="/benchmarks/terminal-bench/terminal-bench-2"]'),
    ).not.toBeNull();
    const count = [...container.querySelectorAll("dt")].find(
      (term) => term.textContent === "Tasks",
    );
    expect(count?.nextElementSibling?.textContent).toBe("2");
    // The tasks grade with an LLM, so a judge credential is asked for.
    expect(container.querySelector("#judge-heading")).not.toBeNull();
    expect(JSON.parse(browser.sessionStorage.getItem(key) ?? "null").draft.tasks).toEqual([
      { runId: "harbor:sha256:a", taskId: "terminal-bench/fix-git" },
      { runId: "harbor:sha256:b", taskId: "terminal-bench/build" },
    ]);
  } finally {
    await act(async () => root.unmount());
    fetch.mockRestore();
    container.remove();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await browser.happyDOM.close();
  }
});
