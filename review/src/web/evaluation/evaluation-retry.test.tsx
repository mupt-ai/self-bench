import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { EvaluationPage } from "./EvaluationPage";
import { RepoRunsProvider } from "./RepoRuns";
import { at, credentials, errored, passed, run } from "./results-fixture";

// Exercise the real Results page, submission, run-list provider and nested retry control together.
test("retrying errors on the open Results page closes confirmation and shows the new run", async () => {
  const url = "/api/orgs/team/repos/owner/repo/evaluations";
  const path = "/repos/owner/repo/results";
  const browser = new Window({ url: `https://selfbench.test${path}` });
  const globals = {
    window: browser,
    document: browser.document,
    sessionStorage: browser.sessionStorage,
    HTMLElement: browser.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const original = run("original", { status: "failed" }, [
    passed("passed-task"),
    errored("errored-task", "Sandbox timed out"),
  ]);
  const retried = run("retry", { status: "running", createdAt: at(1) }, [
    { taskId: "errored-task", status: "running" },
  ]);
  const runs = [original];
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const endpoint = String(input);
    if (endpoint === "/api/orgs/team/credentials")
      return Response.json({
        credentials: [
          ...credentials,
          { id: "modal", name: "Sandbox", kind: "modal", auth: "api-key", createdAt: at(9999) },
        ],
      });
    if (endpoint === `${url}/options`)
      return Response.json({
        tasks: original.trials.map(({ runId, taskId }) => ({ runId, taskId, difficulty: "easy" })),
      });
    if (endpoint === "/api/orgs/team/repos/owner/repo/tasks") return Response.json({ tasks: [] });
    if (endpoint === url) return Response.json({ runs });
    if (endpoint === `${url}/comparisons` && init?.method === "POST") {
      runs.unshift(retried);
      return Response.json({ id: JSON.parse(String(init.body)).id });
    }
    throw new Error(`Unexpected request: ${endpoint}`);
  }) as typeof globalThis.fetch);
  const router = createMemoryRouter(
    [
      {
        element: <Outlet context={{ org: { login: "team" }, orgs: [] }} />,
        children: [
          {
            path: "/repos/:owner/:name/results",
            element: (
              <RepoRunsProvider org="team" url={url} repo="owner/repo">
                <EvaluationPage />
              </RepoRunsProvider>
            ),
          },
        ],
      },
    ],
    { initialEntries: [`${path}?run=original`] },
  );
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry 1 Errored Task",
    );
    if (!retry) throw new Error("Missing retry action");
    await act(async () => retry.click());
    const confirmation = container.querySelector("dialog");
    expect(confirmation).not.toBeNull();
    const confirm = [...(confirmation?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Retry 1 Errored Task",
    );
    if (!confirm) throw new Error("Missing retry confirmation");
    expect(confirm.disabled).toBe(false);
    await act(async () => confirm.click());
    // Navigation stays on Results: a newly submitted comparison must still refresh its list.
    expect(router.state.location.pathname).toBe(path);
    expect(container.querySelector('[data-run-id="retry"]')?.textContent ?? "").toContain(
      "1 running",
    );
    expect(container.querySelector("dialog")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    router.dispose();
    fetch.mockRestore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await browser.happyDOM.close();
  }
});
