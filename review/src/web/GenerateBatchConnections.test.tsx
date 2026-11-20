import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { catalog } from "../../../src/evaluation/catalog";
import { GenerateBatch } from "./GenerateBatch";

// Generation on a stored credential, which may be a Dari connection: its models are offered, and a
// connection that serves no model generation can run says what to connect.

/** Mounts Generate Batch with the given stored credentials, and returns what it renders into. */
async function mountGenerateBatch(credentials: unknown[]) {
  const browser = new Window({ url: "https://selfbench.test" });
  const globals = {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
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
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input) => {
    if (String(input).endsWith("/generation-options"))
      return Response.json({
        models: catalog,
        sandboxes: ["modal"],
        available: true,
        managed: { models: false, sandbox: false },
        credentials,
      });
    throw new Error(`Unexpected request: ${input}`);
  }) as typeof globalThis.fetch);
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find(
      (item) => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label,
    );
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  await act(async () => {
    root.render(
      <MemoryRouter>
        <GenerateBatch repoId={{ org: "team", fullName: "owner/repo" }} />
      </MemoryRouter>,
    );
  });
  await act(async () => button("Generate Batch").click());
  return {
    container,
    button,
    async cleanup() {
      await act(async () => root.unmount());
      fetch.mockRestore();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await browser.happyDOM.close();
    },
  };
}

const dariConnection = (
  id: string,
  name: string,
  models: { id: string; only?: "claude-code" }[],
) => ({
  id,
  name,
  kind: "dari-link",
  auth: "dari-link",
  linkModels: { models, prefixes: [] },
});
const modalSandbox = {
  id: "00000000-0000-4000-8000-000000000004",
  name: "Modal",
  kind: "modal",
  auth: "api-key",
};
const chatgptId = "00000000-0000-4000-8000-000000000003";
const claudeId = "00000000-0000-4000-8000-000000000005";

test("generation runs on a ChatGPT plan connected with Dari, and offers only the models it can run", async () => {
  const mounted = await mountGenerateBatch([
    dariConnection(chatgptId, "Dari · b@example.com", [
      { id: "openai/gpt-6.1-sol" },
      { id: "openai/gpt-6-astra" },
    ]),
    modalSandbox,
  ]);
  try {
    const { container, button } = mounted;
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="Model Credential"]')?.value,
    ).toBe(chatgptId);
    expect(button("Generate").disabled).toBe(false);
    await act(async () => button("Author Model").click());
    const offered = [...container.querySelectorAll('[role="option"]')].map((item) =>
      item.textContent?.trim(),
    );
    expect(offered).toEqual(expect.arrayContaining(["GPT-6.1 Sol", "GPT-6 Astra"]));
    expect(offered).not.toContain("Claude Opus 5.5");
  } finally {
    await mounted.cleanup();
  }
});

test("a Claude plan connected with Dari alone asks for a model, with the reason in a tooltip", async () => {
  const mounted = await mountGenerateBatch([
    dariConnection(claudeId, "Dari · a@example.com", [
      { id: "anthropic/claude-opus-5-5", only: "claude-code" },
    ]),
    modalSandbox,
  ]);
  try {
    const { container, button } = mounted;
    expect(container.textContent).toContain("Connect a model to generate tasks.");
    expect(button("Generate").disabled).toBe(true);
    expect(
      container.querySelector(
        '[aria-label="A ChatGPT or OpenCode Go plan connected with Dari, or any model API key, runs generation. A Claude or Muse plan only runs evaluations."]',
      ),
    ).not.toBeNull();
  } finally {
    await mounted.cleanup();
  }
});
