import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import type { TaskItem } from "../api";
import type { OrgContext } from "../SiteLayout";
import { TaskPage } from "./TaskPage";

const activeTask: TaskItem = {
  runId: "run-one",
  candidateId: "candidate-one",
  taskId: "task-one",
  difficulty: "medium",
  state: "in_progress",
  pipelineStatus: "in_progress",
  stage: "authoring",
  syncedAt: "2026-01-01T00:00:00.000Z",
};

test("a transient refresh failure preserves the task and cancellation state", async () => {
  const browser = new Window({ url: "https://selfbench.test" });
  const globals = {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = document.createElement("div");
  const root = createRoot(container);
  let taskReads = 0;
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const url = String(input);
    if (url.endsWith("/cancel") && init?.method === "POST")
      return Response.json({ state: "requested" });
    if (url.endsWith("/artifacts"))
      return Response.json({
        runId: "run-one",
        taskId: "task-one",
        candidateId: "candidate-one",
        groups: {},
        bundles: [],
        agents: [],
      });
    if (url.includes("/batches/"))
      return Response.json({ error: "batch unavailable" }, { status: 503 });
    if (url.endsWith("/tasks/run-one/task-one")) {
      taskReads += 1;
      return taskReads === 1
        ? Response.json({ task: activeTask })
        : Response.json({ error: "temporarily unavailable" }, { status: 503 });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof globalThis.fetch);
  const org = { login: "Mupt-AI", kind: "org", role: "admin" } as const;
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <Outlet context={{ org, orgs: [org] } satisfies OrgContext} />,
        children: [
          {
            path: "repos/:owner/:name/tasks/:runId/:taskId",
            element: <TaskPage />,
          },
        ],
      },
    ],
    { initialEntries: ["/repos/Mupt-AI/self-bench/tasks/run-one/task-one"] },
  );
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    const cancel = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel Generation",
    );
    expect(cancel).toBeDefined();

    await act(async () => cancel?.click());

    expect(container.textContent).toContain("In Progress");
    expect(container.textContent).toContain("Cancellation Requested…");
    expect(container.textContent).toContain(
      "Task status could not be refreshed. Showing the last update. temporarily unavailable",
    );
  } finally {
    await act(async () => root.unmount());
    fetch.mockRestore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
