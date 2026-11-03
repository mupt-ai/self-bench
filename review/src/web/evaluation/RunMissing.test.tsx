import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { RepoRunsProvider } from "./RepoRuns";
import { RunMissing } from "./RunMissing";

const url = "/api/orgs/team/repos/owner/repo/evaluations";
const tasks = ["t1", "t2"].map((taskId) => ({ runId: "gen", taskId }));

test("Run Missing starts every setting's missing tasks, as each ran before, in one click", async () => {
  const browser = new Window({ url: "https://selfbench.test/repos/owner/repo/run" });
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
  const posted: unknown[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const endpoint = String(input);
    if (endpoint === "/api/orgs/team/credentials")
      return Response.json({
        credentials: [
          { id: "key", name: "OpenAI", kind: "openai", auth: "api-key", createdAt: "" },
          { id: "box", name: "Modal", kind: "modal", auth: "api-key", createdAt: "" },
        ],
      });
    if (endpoint === url)
      return Response.json({
        runs: [
          {
            id: "run-1",
            repoId: 1,
            tenant: "team",
            startedBy: "priya",
            createdAt: "2026-11-01T00:00:00Z",
            model: "sol",
            modelName: "openai/sol",
            harnesses: ["codex"],
            sandbox: "modal",
            credentials: {
              modelCredentialId: "key",
              sandboxCredentialId: "box",
              provider: "openai",
            },
            revision: 1,
            modelLabel: "Sol",
            status: "completed",
            trials: [
              {
                runId: "gen",
                taskId: "t1",
                harness: "codex",
                status: "completed",
                rewards: { reward: 1 },
                log: "",
                steps: [],
                artifacts: [],
              },
            ],
          },
        ],
      });
    if (endpoint === `${url}/comparisons` && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      return Response.json({ id: body.id, runs: [] });
    }
    throw new Error(`Unexpected request: ${endpoint}`);
  }) as typeof globalThis.fetch);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/repos/owner/repo/run"]}>
          <Routes>
            <Route
              path="/repos/owner/repo/run"
              element={
                <RepoRunsProvider org="team" url={url}>
                  <RunMissing url={url} pages="/repos/owner/repo" tasks={tasks} />
                </RepoRunsProvider>
              }
            />
            <Route path="/repos/owner/repo/results" element={<p>Results</p>} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(container.textContent).toContain("1 setting run here is missing 1 result");
    const open = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Run 1 Missing Trial"),
    );
    await act(async () => open?.click());
    const confirm = [...document.querySelectorAll("dialog button")].find(
      (button) => button.textContent === "Run 1 Missing Trial",
    ) as HTMLButtonElement | undefined;
    await act(async () => confirm?.click());
    expect(posted).toMatchObject([
      {
        models: [{ catalogId: "sol", credentialId: "key", harnesses: ["codex"] }],
        sandbox: "modal",
        sandboxCredentialId: "box",
        tasks: [{ runId: "gen", taskId: "t2" }],
        skipCompleted: true,
      },
    ]);
    expect(container.textContent).toContain("Results");
  } finally {
    await act(async () => root.unmount());
    fetch.mockRestore();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await browser.happyDOM.close();
  }
});
