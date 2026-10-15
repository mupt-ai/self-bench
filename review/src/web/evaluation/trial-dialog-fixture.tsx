import { afterEach, beforeEach, expect } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import { initialEvaluation } from "../../../../src/evaluation/store";
import { evaluationInput } from "../../../../tests/support/evaluation-fixture";
import { SessionContext, type SessionState } from "../session";
import type { EvaluationRun } from "./api";
import { TrialDialog } from "./TrialDialog";

let root: Root;
let restoreGlobals: () => void;
export const dialog = {
  browser: undefined as unknown as Window,
  requests: [] as { url: string; body?: unknown }[],
  explainState: {} as object,
  credentials: [] as CredentialInfo[],
  models: [] as CatalogModel[],
  explainedResult: true,
};

export const BASE = "/api/orgs/avyay/repos/avyay/repo/evaluations";
export const SUMMARY = { text: "The parser still drops trailing commas.", model: "gpt-6-luna" };
export const key = (
  id: string,
  kind: CredentialInfo["kind"],
  auth: CredentialInfo["auth"] = "api-key",
): CredentialInfo => ({
  id,
  name: `Saved ${id}`,
  kind,
  auth,
  createdAt: "2026-09-11T00:00:00Z",
});
export const catalogModel = (id: string, provider: CatalogModel["provider"]): CatalogModel => ({
  id,
  provider,
  model: `${id}-provider-id`,
  label: `Model ${id}`,
  harnesses: ["pi"],
  source: "",
  gateways: { openrouter: `router/${id}`, "vercel-ai-gateway": `vercel/${id}` },
});

export function failedRun(explained = false): EvaluationRun {
  const run = initialEvaluation(
    { ...evaluationInput(), id: "6f9c1a52-1111-4222-8333-444455556666" },
    "Test",
  );
  run.status = "completed";
  Object.assign(run.trials[0] ?? {}, {
    status: "completed",
    rewards: { reward: 0 },
    ...(explained ? { failureSummary: SUMMARY } : {}),
  });
  return run;
}

export function setupTrialDialogTests() {
  beforeEach(() => {
    dialog.browser = new Window({ url: "https://selfbench.test" });
    dialog.requests = [];
    dialog.explainState = { available: true, running: false };
    dialog.credentials = [
      key("openai-key", "openai"),
      key("anthropic-key", "anthropic"),
      key("router-key", "openrouter"),
      key("vercel-key", "vercel-ai-gateway"),
      key("custom-key", "custom"),
    ];
    dialog.models = [
      catalogModel("openai-model", "openai"),
      catalogModel("anthropic-model", "anthropic"),
    ];
    dialog.explainedResult = true;
    const globals = {
      window: dialog.browser,
      document: dialog.browser.document,
      HTMLElement: dialog.browser.HTMLElement,
      getComputedStyle: dialog.browser.getComputedStyle.bind(dialog.browser),
      IS_REACT_ACT_ENVIRONMENT: true,
      fetch: async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        dialog.requests.push({ url, ...(body ? { body } : {}) });
        if (url.endsWith("/credentials")) return Response.json({ credentials: dialog.credentials });
        if (url.endsWith("/catalog"))
          return Response.json({
            models: dialog.models,
            managed: { models: false, sandbox: false },
          });
        if (url.includes("/explain?")) return Response.json(dialog.explainState);
        if (url.endsWith("/explain")) return Response.json({}, { status: 202 });
        return Response.json(failedRun(dialog.explainedResult));
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
    await dialog.browser.happyDOM.close();
  });
}

export async function open(run = failedRun(), managedOffering = false, signedIn = true) {
  const session: SessionState = signedIn
    ? {
        status: "signed-in",
        user: { githubId: 1, login: "avyay" },
        orgs: [],
        managedOffering,
      }
    : { status: "anonymous" };
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
            pages="/repos/avyay/repo"
            onClose={() => {}}
          />
        </MemoryRouter>
      </SessionContext.Provider>,
    ),
  );
}

export const explainButton = () =>
  [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Explain Failure",
  );
export const posts = () => dialog.requests.filter((request) => request.body);
const keySelect = () => document.querySelector("select") as HTMLSelectElement;
export async function chooseKey(id: string) {
  await act(async () => {
    keySelect().value = id;
    keySelect().dispatchEvent(
      new dialog.browser.Event("change", { bubbles: true }) as unknown as Event,
    );
  });
}
export async function chooseModel(id: string) {
  const picker = document.querySelector(
    'button[aria-label="Explanation Model"]',
  ) as HTMLButtonElement;
  await act(async () => picker.click());
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (entry) => entry.textContent === `Model ${id}`,
  ) as HTMLButtonElement;
  if (!option) throw new Error(`Missing model ${id}`);
  await act(async () => option.click());
}
export async function submitExplanation() {
  const button = explainButton();
  if (!button) throw new Error("Missing Explain Failure");
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
}
