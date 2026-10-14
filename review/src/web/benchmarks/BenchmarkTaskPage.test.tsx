import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { BenchmarkTaskPage } from "./BenchmarkTaskPage";

test("a benchmark task opens in the task view with the files frozen when it was added", async () => {
  const browser = new Window({ url: "https://selfbench.test" });
  const globals = {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
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
    requests.push(String(input));
    return Response.json({
      taskId: "terminal-bench/fix-git",
      files: [
        { path: "instruction.md", sizeBytes: 12, text: "Fix the repo" },
        { path: "task.toml", sizeBytes: 20, text: 'version = "1.0"' },
      ],
    });
  }) as typeof globalThis.fetch);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <MemoryRouter
          initialEntries={[
            "/benchmarks/terminal-bench/terminal-bench-2/tasks/terminal-bench/fix-git",
          ]}
        >
          <Routes>
            <Route element={<Outlet context={{ org: { login: "team" }, orgs: [] }} />}>
              <Route path="/benchmarks/:owner/:name/tasks/*" element={<BenchmarkTaskPage />} />
            </Route>
          </Routes>
        </MemoryRouter>,
      );
    });
    expect(container.querySelector("h1")?.textContent).toBe("terminal-bench/fix-git");
    expect(requests).toEqual([
      "/api/orgs/team/benchmarks/terminal-bench/terminal-bench-2/task-files?task=terminal-bench%2Ffix-git",
    ]);
    expect(container.querySelector('[aria-label="Files"]')?.textContent).toContain("task.toml");
    expect(container.textContent).toContain("Fix the repo");
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
