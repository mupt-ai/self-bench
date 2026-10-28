import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { MAX_SUMMARY_CONFIGURATIONS } from "../../../../src/contracts/model-summary-limit";
import { SessionContext } from "../session";
import { ModelSummaries } from "./ModelSummaries";
import { RepoRunsProvider } from "./RepoRuns";
import { credentials, passed, run } from "./results-fixture";
import { configurationsOf } from "./results-model";
import { BASE, chooseKey, dialog, posts, setupTrialDialogTests } from "./trial-dialog-fixture";

setupTrialDialogTests();

const runs = [run("r", {}, [passed("task-1"), { ...passed("task-2"), rewards: { reward: 0 } }])];
const [configuration] = configurationsOf(runs, credentials);
const key = configuration?.key ?? "";

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((entry) => entry.textContent === label);

/** The Results page's Model Summaries button, under the runs the stubbed fetch answers. */
async function mount() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <SessionContext.Provider
        value={{
          session: {
            status: "signed-in",
            user: { githubId: 1, login: "avyay" },
            orgs: [],
            managedOffering: false,
          },
          signOut: async () => undefined,
        }}
      >
        <MemoryRouter initialEntries={["/repos/avyay/repo/results"]}>
          <RepoRunsProvider org="avyay" url={BASE} repo="avyay/repo">
            <ModelSummaries />
          </RepoRunsProvider>
        </MemoryRouter>
      </SessionContext.Provider>,
    ),
  );
  return root;
}

test("Model Summaries shows the last report and asks for another", async () => {
  const answered = globalThis.fetch;
  let running: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === BASE) return Response.json({ runs });
    if (url.endsWith("/options"))
      return Response.json({
        tasks: ["task-1", "task-2"].map((taskId) => ({
          runId: "batch-1",
          taskId,
          difficulty: "easy",
        })),
      });
    if (url.endsWith("/repos/avyay/repo/tasks")) return Response.json({ tasks: [] });
    if (url.endsWith("/summaries") && init?.body) {
      dialog.requests.push({ url, body: JSON.parse(String(init.body)) });
      running = [key];
      return Response.json({ configurations: [key] }, { status: 202 });
    }
    if (url.endsWith("/summaries"))
      return Response.json({
        available: true,
        running,
        report: {
          overview: "All of them stop before changes are wired through.",
          model: "gpt-6-luna",
          summarizedAt: "2026-09-28T10:00:00.000Z",
          summaries: [
            {
              configuration: key,
              text: "Solid on parsers; it misses cache invalidation.",
              tasks: 1,
              passed: 1,
            },
          ],
        },
      });
    return answered(url, init);
  }) as typeof fetch;
  const root = await mount();
  const open = button("Model Summaries");
  if (!open) throw new Error("Missing Model Summaries");
  await act(async () => open.click());
  expect(document.body.textContent).toContain("All of them stop before changes are wired through.");
  expect(document.body.textContent).toContain("Solid on parsers; it misses cache invalidation.");
  // Summarized from one task; two are scored now.
  expect(document.body.textContent).toContain("Its results have changed since");

  await chooseKey("openai-key");
  const picker = document.querySelector('button[aria-label="Summary Model"]') as HTMLButtonElement;
  await act(async () => picker.click());
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (entry) => entry.textContent === "Model openai-model",
  ) as HTMLButtonElement;
  await act(async () => option.click());
  const summarize = button("Summarize Models");
  expect(summarize?.disabled).toBe(false);
  await act(async () => summarize?.click());
  expect(posts().at(-1)).toEqual({
    url: `${BASE}/summaries`,
    body: { configurations: [key], summary: { credentialId: "openai-key", model: "openai-model" } },
  });
  expect(document.body.textContent).toContain("Comparing 1 configuration…");
  await act(async () => root.unmount());
});

test("more configurations than one report compares are refused before any request", async () => {
  const answered = globalThis.fetch;
  const many = Array.from({ length: MAX_SUMMARY_CONFIGURATIONS + 1 }, (_, index) =>
    run(`r${index}`, { model: `gpt-${index}`, modelName: `openai/gpt-${index}` }, [
      passed("task-1"),
    ]),
  );
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === BASE) return Response.json({ runs: many });
    if (url.endsWith("/options"))
      return Response.json({ tasks: [{ runId: "batch-1", taskId: "task-1", difficulty: "easy" }] });
    if (url.endsWith("/summaries")) return Response.json({ available: true, running: [] });
    return answered(url, init);
  }) as typeof fetch;
  const root = await mount();
  await act(async () => button("Model Summaries")?.click());
  expect(document.body.textContent).toContain(
    `Choose at most ${MAX_SUMMARY_CONFIGURATIONS} configurations to compare`,
  );
  expect(button("Summarize Models")).toBeUndefined();
  await act(async () => root.unmount());
});
