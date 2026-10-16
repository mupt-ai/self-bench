import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { SessionContext } from "../session";
import { credentials, passed, run } from "./results-fixture";
import { configurationsOf } from "./results-model";
import { TaskAuditDialog } from "./TaskAuditDialog";
import { outcomeGridTasks } from "./TaskOutcomeGrid";
import { BASE, dialog, setupTrialDialogTests } from "./trial-dialog-fixture";

setupTrialDialogTests();

async function renderAuditDialog(trial: ReturnType<typeof passed>) {
  const configurations = configurationsOf([run("r", {}, [trial])], credentials);
  const [task] = outcomeGridTasks(configurations);
  if (!task) throw new Error("Missing task");
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
        <MemoryRouter>
          <TaskAuditDialog
            task={task}
            configurations={configurations}
            baseUrl={BASE}
            pages="/repos/avyay/repo"
            onClose={() => {}}
            onOpenTrial={() => {}}
          />
        </MemoryRouter>
      </SessionContext.Provider>,
    ),
  );
  return root;
}

test("Audit Task's key picker shows while the audit's state is still loading", async () => {
  const answered = globalThis.fetch;
  // The audit's state (its last verdict and workflow) never answers.
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    url.includes("/audit?") ? new Promise(() => {}) : answered(url, init)) as typeof fetch;
  const root = await renderAuditDialog({ ...passed("task-1"), rewards: { reward: 0 } });
  expect(document.body.textContent).toContain("Model API Key");
  expect(
    [...document.querySelectorAll("button")].some((button) => button.textContent === "Audit Task"),
  ).toBe(true);
  expect(dialog.requests.some((request) => request.url.endsWith("/credentials"))).toBe(true);
  await act(async () => root.unmount());
});

test("unverified failures do not offer an audit the server cannot start", async () => {
  const root = await renderAuditDialog({
    ...passed("task-1"),
    rewards: { reward: 0 },
    modelVerified: false,
  });
  expect(document.body.textContent).toContain("1 of 1 scored attempt failed");
  expect(document.body.textContent).toContain("No verified failed attempt is available to audit.");
  expect(
    [...document.querySelectorAll("button")].some((button) => button.textContent === "Audit Task"),
  ).toBe(false);
  await act(async () => root.unmount());
});
