import { expect, test } from "bun:test";
import { act } from "react";
import {
  BASE,
  catalogModel,
  chooseKey,
  chooseModel,
  dialog,
  explainButton,
  failedRun,
  key,
  open,
  posts,
  SUMMARY,
  setupTrialDialogTests,
  submitExplanation,
} from "./trial-dialog-fixture";

setupTrialDialogTests();

test.each([false, true])(
  "saved-key explanation works with managed offering %s; only click starts it",
  async (managed) => {
    const run = failedRun();
    await open(run, managed);
    expect(explainButton()?.disabled).toBe(true);
    expect(posts()).toEqual([]);
    expect(dialog.requests).toContainEqual({ url: "/api/orgs/avyay/credentials" });
    expect(dialog.requests).toContainEqual({ url: `${BASE}/catalog` });
    await chooseKey("openai-key");
    await chooseModel("openai-model");
    expect(explainButton()?.disabled).toBe(false);
    expect(posts()).toEqual([]);
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(document.body.textContent).toContain("Provider charges apply.");
    await submitExplanation();
    expect(posts()).toEqual([
      {
        url: `${BASE}/${run.id}/explain`,
        body: {
          runId: "run-one",
          taskId: "task-one",
          harness: "codex",
          explanation: { credentialId: "openai-key", model: "openai-model" },
        },
      },
    ]);
    expect(document.body.textContent).toContain(SUMMARY.text);
    expect(explainButton()).toBeUndefined();
  },
);

test("a benchmark's trial offers Explain Failure with the org's saved keys", async () => {
  const run = failedRun();
  const baseUrl = "/api/orgs/avyay/benchmarks/terminal-bench/dataset/evaluations";
  await open(run, false, true, { baseUrl, pages: "/benchmarks/terminal-bench/dataset" });
  expect(dialog.requests).toContainEqual({ url: "/api/orgs/avyay/credentials" });
  expect(dialog.requests).toContainEqual({ url: `${baseUrl}/catalog` });
  await chooseKey("openai-key");
  await chooseModel("openai-model");
  await submitExplanation();
  expect(posts()[0]?.url).toBe(`${baseUrl}/${run.id}/explain`);
});

test.each(["router-key", "vercel-key", "anthropic-key"])(
  "%s uses compatible catalog IDs, not provider IDs",
  async (id) => {
    await open();
    await chooseKey(id);
    await chooseModel("anthropic-model");
    await submitExplanation();
    expect(posts()[0]?.body).toEqual({
      runId: "run-one",
      taskId: "task-one",
      harness: "codex",
      explanation: { credentialId: id, model: "anthropic-model" },
    });
  },
);

test("direct keys show only compatible models and changing key clears stale selection", async () => {
  await open();
  await chooseKey("openai-key");
  await act(async () =>
    (document.querySelector('button[aria-label="Explanation Model"]') as HTMLButtonElement).click(),
  );
  expect(
    [...document.querySelectorAll('[role="option"]')].map((entry) => entry.textContent),
  ).toEqual(["Model openai-model"]);
  await act(async () => (document.querySelector('[role="option"]') as HTMLButtonElement).click());
  await chooseKey("anthropic-key");
  expect(explainButton()?.disabled).toBe(true);
  await chooseModel("anthropic-model");
  await chooseKey("router-key");
  await chooseModel("openai-model");
  await chooseModel("anthropic-model");
  expect(explainButton()?.disabled).toBe(false);
  expect(posts()).toEqual([]);
});

test("custom endpoint requires a nonblank raw model ID and sends no endpoint/provider", async () => {
  dialog.credentials = [{ ...key("custom-key", "custom"), endpoint: "https://approved.test/v1" }];
  dialog.models = [];
  await open();
  await chooseKey("custom-key");
  expect(document.querySelector('button[aria-label="Explanation Model"]')).toBeNull();
  const input = document.querySelector('input[placeholder="Model ID"]') as HTMLInputElement;
  const type = async (value: string) =>
    act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        dialog.browser.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, value);
      input.dispatchEvent(new dialog.browser.Event("input", { bubbles: true }) as unknown as Event);
    });
  await type("   ");
  expect(explainButton()?.disabled).toBe(true);
  await type("  vendor/my-custom-model  ");
  await submitExplanation();
  expect(posts()[0]?.body).toEqual({
    runId: "run-one",
    taskId: "task-one",
    harness: "codex",
    explanation: { credentialId: "custom-key", model: "vendor/my-custom-model" },
  });
});

test("subscription and sandbox credentials are excluded; no compatible key links to Manage Credentials", async () => {
  dialog.credentials = [
    key("chatgpt", "openai", "codex-login"),
    key("claude", "anthropic", "claude-login"),
    ...(["e2b", "modal", "daytona", "vercel"] as const).map((kind) => key(kind, kind)),
  ];
  await open();
  expect(explainButton()).toBeUndefined();
  expect(document.body.textContent).toContain("No compatible saved model API keys");
  expect(document.querySelector('a[href="/settings/credentials"]')?.textContent).toBe(
    "Manage Credentials",
  );
  expect(posts()).toEqual([]);
});

test("keys without a compatible catalog route are not offered", async () => {
  dialog.credentials = [key("anthropic-key", "anthropic")];
  dialog.models = [catalogModel("openai-model", "openai")];
  await open();
  expect(document.body.textContent).toContain("No compatible saved model API keys");
  expect(posts()).toEqual([]);
});

test("explained, passed and signed-out trials do not load explanation metadata or make calls", async () => {
  await open(failedRun(true));
  expect(explainButton()).toBeUndefined();
  const passed = failedRun();
  Object.assign(passed.trials[0] ?? {}, { rewards: { reward: 1 } });
  await open(passed);
  await open(failedRun(), false, false);
  expect(explainButton()).toBeUndefined();
  expect(dialog.requests).toEqual([]);
});

test("unavailable evidence/cooldown reason is shown without starting a request", async () => {
  dialog.explainState = { available: false, running: false, reason: "Try again in a few minutes." };
  await open();
  expect(document.body.textContent).toContain("Try again in a few minutes.");
  expect(explainButton()).toBeUndefined();
  expect(dialog.requests).toHaveLength(1);
});

test("an already running explanation polls by identity and shows its summary without needing a key", async () => {
  dialog.credentials = [];
  const answer = globalThis.fetch;
  let checks = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.includes("/explain?") && checks++ === 0) {
      dialog.requests.push({ url });
      return Response.json({ available: false, running: true });
    }
    return answer(url, init);
  }) as typeof fetch;
  await open();
  expect(document.body.textContent).toContain(SUMMARY.text);
  expect(posts()).toEqual([]);
  const checksMade = dialog.requests.filter((request) => request.url.includes("/explain?"));
  expect(checksMade).toHaveLength(2);
  for (const request of checksMade) {
    const params = new URL(request.url, "https://selfbench.test").searchParams;
    expect([...params.keys()].sort()).toEqual(["harness", "runId", "taskId"]);
  }
});

test("a trial explained after the page read its run shows its explanation on opening", async () => {
  dialog.explainState = { available: false, running: false, explained: true };
  await open();
  expect(document.body.textContent).toContain(SUMMARY.text);
  expect(explainButton()).toBeUndefined();
  expect(posts()).toEqual([]);
});

test("a refused request refreshes state; a newly written explanation replaces the refusal", async () => {
  await open();
  await chooseKey("openai-key");
  await chooseModel("openai-model");
  dialog.explainState = { available: false, running: false, explained: true };
  const refusal = "Only a trial that failed its tests and has no explanation yet can be explained.";
  const answer = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    url.endsWith("/explain")
      ? Response.json({ error: refusal }, { status: 409 })
      : answer(url, init)) as typeof fetch;
  await submitExplanation();
  expect(document.body.textContent).toContain(SUMMARY.text);
  expect(document.body.textContent).not.toContain(refusal);
});

test("deleted credential/refused requests show server error without automatically retrying a paid request", async () => {
  await open();
  await chooseKey("openai-key");
  await chooseModel("openai-model");
  const answer = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (!url.endsWith("/explain")) return answer(url, init);
    dialog.requests.push({ url, body: JSON.parse(String(init?.body)) });
    return Response.json({ error: "Credential not found" }, { status: 400 });
  }) as typeof fetch;
  await submitExplanation();
  expect(document.body.textContent).toContain("Credential not found");
  expect(posts()).toHaveLength(1);
});

test("metadata failures are visible and cannot start paid calls", async () => {
  const answer = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    url.endsWith("/catalog")
      ? Response.json({ error: "Catalog unavailable" }, { status: 503 })
      : answer(url, init)) as typeof fetch;
  await open();
  expect(document.body.textContent).toContain("Catalog unavailable");
  expect(explainButton()).toBeUndefined();
  expect(posts()).toEqual([]);
});

test("a pending POST disables controls and repeated clicks cannot start another paid call", async () => {
  await open();
  await chooseKey("openai-key");
  await chooseModel("openai-model");
  const answer = globalThis.fetch;
  let finish!: (response: Response) => void;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (!url.endsWith("/explain")) return answer(url, init);
    dialog.requests.push({ url, body: JSON.parse(String(init?.body)) });
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  }) as typeof fetch;
  const button = explainButton();
  if (!button) throw new Error("Missing Explain Failure");
  await act(async () => button.click());
  expect(button.disabled).toBe(true);
  expect(document.querySelector("fieldset")?.disabled).toBe(true);
  await act(async () => button.click());
  expect(posts()).toHaveLength(1);
  await act(async () => finish(Response.json({}, { status: 202 })));
  expect(document.body.textContent).toContain(SUMMARY.text);
});

test("a completed attempt without a summary never automatically retries", async () => {
  dialog.explainedResult = false;
  await open();
  await chooseKey("openai-key");
  await chooseModel("openai-model");
  await submitExplanation();
  expect(document.body.textContent).toContain("No explanation came back");
  expect(posts()).toHaveLength(1);
});

test("the sole compatible key is preselected but even a sole model needs an explicit choice", async () => {
  dialog.credentials = [key("openai-key", "openai"), key("subscription", "openai", "codex-login")];
  await open();
  expect((document.querySelector("select") as HTMLSelectElement).value).toBe("openai-key");
  expect(explainButton()?.disabled).toBe(true);
  await chooseModel("openai-model");
  expect(explainButton()?.disabled).toBe(false);
  expect(posts()).toEqual([]);
});

test("the dialog shows the run alone, with View Task opening the task's page in a new tab", async () => {
  await open();
  expect(document.querySelector('[role="tab"]')).toBeNull();
  const view = [...document.querySelectorAll("a")].find((link) => link.textContent === "View Task");
  expect(view?.getAttribute("href")).toBe("/repos/avyay/repo/tasks/run-one/task-one");
  expect(view?.getAttribute("target")).toBe("_blank");
});
