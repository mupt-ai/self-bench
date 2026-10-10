import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { initialEvaluation } from "../../../../src/evaluation/store";
import { evaluationInput } from "../../../../tests/support/evaluation-fixture";
import { SessionContext, type SessionState } from "../session";
import type { EvaluationRun } from "./api";
import { TrialDialog } from "./TrialDialog";

let browser: Window;
let root: Root;
let restoreGlobals: () => void;
let requests: { url: string; body?: unknown }[];

const BASE = "/api/orgs/avyay/repos/avyay/repo/evaluations";
const SUMMARY = { text: "The parser still drops trailing commas.", model: "gpt-6-luna" };

/** A finished run whose one trial failed its tests; `explained` adds its explanation. */
function failedRun(explained = false): EvaluationRun {
  const input = evaluationInput();
  const run = initialEvaluation({ ...input, id: "6f9c1a52-1111-4222-8333-444455556666" }, "Test");
  run.status = "completed";
  Object.assign(run.trials[0] ?? {}, {
    status: "completed",
    rewards: { reward: 0 },
    ...(explained ? { failureSummary: SUMMARY } : {}),
  });
  return run;
}

beforeEach(() => {
  browser = new Window({ url: "https://selfbench.test" });
  requests = [];
  const globals = {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, ...(body ? { body } : {}) });
      // The trial can be explained and nothing is running; once asked, the run comes back explained.
      if (url.includes("/explain?")) return Response.json({ available: true, running: false });
      if (url.endsWith("/explain")) return Response.json({}, { status: 202 });
      return Response.json(failedRun(true));
    },
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
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  restoreGlobals();
  await browser.happyDOM.close();
});

async function open(run: EvaluationRun, managedOffering: boolean) {
  const session: SessionState = {
    status: "signed-in",
    user: { githubId: 1, login: "avyay" },
    orgs: [],
    managedOffering,
  };
  const trial = run.trials[0];
  if (!trial) throw new Error("Missing trial");
  await act(async () =>
    root.render(
      <SessionContext.Provider value={{ session, signOut: async () => undefined }}>
        <MemoryRouter>
          <TrialDialog
            run={run}
            trial={trial}
            loaded
            baseUrl={BASE}
            repo="avyay/repo"
            onClose={() => {}}
          />
        </MemoryRouter>
      </SessionContext.Provider>,
    ),
  );
}

const explainButton = () =>
  [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Explain Failure",
  );

test("Explain Failure asks for the trial's explanation and shows it when it arrives", async () => {
  const run = failedRun();
  await open(run, true);
  const button = explainButton();
  if (!button) throw new Error("Missing Explain Failure");
  await act(async () => button.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(requests).toContainEqual({
    url: `${BASE}/${run.id}/explain`,
    body: { runId: "run-one", taskId: "task-one", harness: "codex" },
  });
  expect(document.body.textContent).toContain(SUMMARY.text);
  expect(explainButton()).toBeUndefined();
});

test("Explain Failure is offered only for an unexplained failure on managed models", async () => {
  await open(failedRun(), false);
  expect(explainButton()).toBeUndefined();
  await open(failedRun(true), true);
  expect(explainButton()).toBeUndefined();
  const passed = failedRun();
  Object.assign(passed.trials[0] ?? {}, { rewards: { reward: 1 } });
  await open(passed, true);
  expect(explainButton()).toBeUndefined();
  expect(requests).toEqual([]);
});
