import { expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { GenerateBatch } from "./GenerateBatch";

test("batch creation advances without starting, then closes and opens the submitted batch once", async () => {
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
  document.body.append(container);
  const root = createRoot(container);
  const base = "/api/orgs/team/repos/owner/repo/batches";
  const start = Promise.withResolvers<Response>();
  const onStarted = mock(() => {});
  const submissions: unknown[] = [];
  let optionsAvailable = true;
  let optionsFail = false;
  let hasSandbox = true;
  const modelId = "00000000-0000-4000-8000-000000000001";
  const sandboxId = "00000000-0000-4000-8000-000000000002";
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    if (String(input).endsWith("/generation-options"))
      return optionsFail
        ? Response.json({ error: "Settings unavailable" }, { status: 503 })
        : Response.json({
            models: ["gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-luna"],
            sandboxes: ["modal", "docker"],
            available: optionsAvailable,
            credentials: [
              { id: modelId, kind: "openai", auth: "api-key", name: "Model" },
              ...(hasSandbox
                ? [{ id: sandboxId, kind: "modal", auth: "api-key", name: "Sandbox" }]
                : []),
            ],
          });
    if (String(input) === base && init?.method === "POST") {
      submissions.push(JSON.parse(String(init.body)));
      return start.promise;
    }
    throw new Error(`Unexpected request: ${input}`);
  }) as typeof globalThis.fetch);
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find(
      (item) => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label,
    );
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  try {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <GenerateBatch repoId={{ org: "team", fullName: "owner/repo" }} onStarted={onStarted} />
        </MemoryRouter>,
      );
    });
    await act(async () => button("Generate Batch").click());
    expect(container.querySelector("dialog")?.open).toBe(true);
    for (const label of ["Easy Candidates", "Medium Candidates", "Hard Candidates"])
      expect(container.querySelector(`input[aria-label="${label}"]`)).not.toBeNull();
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Set Counts");
    await act(async () => button("Continue").click());
    expect(submissions).toHaveLength(0);
    expect(container.querySelector("input[type=number]")).toBeNull();
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain(
      "Configure Generation",
    );
    const select = async (label: string, value: string) => {
      await act(async () => {
        const field = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
        if (!field) throw new Error(`Missing field ${label}`);
        field.value = value;
        field.dispatchEvent(new browser.Event("change", { bubbles: true }) as unknown as Event);
      });
    };
    expect(button("Generate").disabled).toBe(false);
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="OpenAI Credential"]')?.value,
    ).toBe(modelId);
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="Modal Credential"]')?.value,
    ).toBe(sandboxId);
    await select("Author Model", "gpt-6-astra");
    await select("Verifier Model", "gpt-5.6-luna");
    await select("Reasoning", "low");
    await select("Modal Credential", "");
    await select("OpenAI Credential", modelId);
    expect(button("Generate").disabled).toBe(true);
    await select("Sandbox", "docker");
    expect(button("Generate").disabled).toBe(false);
    expect(container.querySelector('select[aria-label="Modal Credential"]')).toBeNull();
    await select("Sandbox", "modal");
    expect(button("Generate").disabled).toBe(false);
    await select("Modal Credential", sandboxId);
    expect(button("Generate").disabled).toBe(false);
    await act(async () => button("Back").click());
    expect(container.querySelector("select")).toBeNull();
    // Enter on the counts form only advances, even with valid saved settings.
    await act(async () =>
      browser.document
        .querySelector("form")
        ?.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(submissions).toHaveLength(0);
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="Author Model"]')?.value,
    ).toBe("gpt-6-astra");
    await act(async () => {
      browser.document
        .querySelector("form")
        ?.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(submissions).toEqual([
      {
        candidateCounts: { easy: 1, medium: 1, hard: 1 },
        generation: {
          authorModel: "gpt-6-astra",
          verifierModel: "gpt-5.6-luna",
          reasoning: "low",
          sandbox: "modal",
          modelCredentialId: modelId,
          sandboxCredentialId: sandboxId,
        },
      },
    ]);
    await act(async () =>
      browser.document
        .querySelector("form")
        ?.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(submissions).toHaveLength(1);
    expect(button("Close").disabled).toBe(true);
    expect(button("Back").disabled).toBe(true);
    const cancel = new browser.Event("cancel", { cancelable: true });
    await act(async () => browser.document.querySelector("dialog")?.dispatchEvent(cancel));
    expect(cancel.defaultPrevented).toBe(true);
    expect(container.querySelector("dialog")?.open).toBe(true);
    await act(async () => start.resolve(Response.json({ runId: "batch-test" })));
    expect(onStarted).toHaveBeenCalledWith("batch-test");
    expect(container.querySelector("dialog")).toBeNull();
    await act(async () => button("Generate Batch").click());
    expect(container.textContent).not.toContain("batch-test");
    expect(submissions).toHaveLength(1);
    expect(container.querySelector("select")).toBeNull();
    await act(async () => button("Continue").click());
    hasSandbox = false;
    await act(async () => browser.dispatchEvent(new browser.Event("focus")));
    expect(button("Generate").disabled).toBe(true);
    expect(container.textContent).toContain("Unavailable Credential");
    hasSandbox = true;
    optionsAvailable = false;
    await act(async () => browser.dispatchEvent(new browser.Event("focus")));
    expect(button("Generate").disabled).toBe(true);
    optionsFail = true;
    await act(async () => browser.dispatchEvent(new browser.Event("focus")));
    expect(container.textContent).toContain("Settings unavailable");
    expect(button("Generate").disabled).toBe(true);
    optionsFail = false;
    optionsAvailable = true;
    await act(async () => button("Try Again").click());
    expect(button("Generate").disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    fetch.mockRestore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await browser.happyDOM.close();
  }
});
