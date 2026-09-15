import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApiKeysPage } from "./ApiKeysPage";

const root_ = "/api/api-keys";
const key = {
  id: 1,
  name: "CI",
  prefix: "sbk_abcd1234",
  scope: "write",
  createdAt: "2026-09-14T10:00:00.000Z",
};
const secret = "sbk_abcd1234efgh5678ijkl9012mnop3456qrst7890uvwx";

let browser: Window;
let root: Root;
let container: HTMLDivElement;
let restoreGlobals: () => void;
let restoreFetch: () => void;
let requests: string[];
let keys: (typeof key)[];

beforeEach(async () => {
  browser = new Window({ url: "https://selfbench.test" });
  const globals = {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    navigator: browser.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
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
  requests = [];
  keys = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${path}`);
    if (method === "GET" && path === root_) return Response.json({ keys });
    if (method === "POST" && path === root_) {
      const body = JSON.parse(String(init?.body)) as { name: string; scope: string };
      keys = [{ ...key, name: body.name, scope: body.scope }];
      return Response.json({ key: keys[0], secret }, { status: 201 });
    }
    if (method === "DELETE" && path === `${root_}/1`) {
      keys = [];
      return Response.json({ ok: true });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  }) as typeof globalThis.fetch);
  restoreFetch = () => fetch.mockRestore();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<ApiKeysPage />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  restoreFetch();
  restoreGlobals();
  await browser.happyDOM.close();
});

function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (item) => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!predicate() && Date.now() < deadline)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
  expect(predicate()).toBe(true);
}
function submit() {
  const found = container.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!found) throw new Error("Missing submit button");
  return found;
}
/**
 * react-dom decides at import time whether `input` events exist; the DOM is installed later in
 * these tests, so React falls back to its legacy change detection, which watches the focused
 * element (via `attachEvent`) and compares its value on `keyup`.
 */
async function type(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`Missing field: ${id}`);
  Object.assign(input, { attachEvent() {}, detachEvent() {} });
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  const event = (name: string) => new browser.Event(name, { bubbles: true }) as unknown as Event;
  await act(async () => input.dispatchEvent(event("focusin")));
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(event("keyup"));
  });
}

test("creates a key, reveals the secret exactly once, and revokes it from the list", async () => {
  await waitFor(() => container.textContent?.includes("No API keys yet") ?? false);
  await click("Create Key");
  expect(submit().disabled).toBe(true);
  await type("api-key-name", "CI");
  expect(submit().disabled).toBe(false);
  await act(async () => submit().click());
  await waitFor(() => !!container.querySelector('[data-testid="api-key-secret"]'));
  expect(container.querySelector('[data-testid="api-key-secret"]')?.textContent).toBe(secret);
  expect(requests).toContain(`POST ${root_}`);
  await waitFor(() => !!container.querySelector("tbody tr"));
  const row = container.querySelector("tbody tr");
  expect(row?.textContent).toContain("CI");
  expect(row?.textContent).toContain("sbk_abcd1234…");
  expect(row?.textContent).toContain("Read & Write");
  expect(row?.textContent).toContain("Never");
  expect(row?.textContent).not.toContain(secret);

  await click("Revoke CI");
  expect(container.textContent).toContain("Revoke API Key");
  await click("Revoke");
  await waitFor(() => container.textContent?.includes("No API keys yet") ?? false);
  expect(requests).toContain(`DELETE ${root_}/1`);
  expect(container.querySelector('[data-testid="api-key-secret"]')).toBeNull();
  expect(container.textContent).toContain("API key revoked.");
});

test("reports a failed load and offers to reload", async () => {
  restoreFetch();
  const failing = spyOn(globalThis, "fetch").mockImplementation((async () =>
    Response.json({ error: "database unavailable" }, { status: 503 })) as unknown as typeof fetch);
  await act(async () => root.render(<ApiKeysPage key="retry" />));
  await waitFor(() => !!container.querySelector('[role="alert"]'));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("database unavailable");
  expect(button("Reload List")).toBeDefined();
  failing.mockRestore();
  restoreFetch = () => undefined;
});

async function createKey() {
  await waitFor(() => container.textContent?.includes("No API keys yet") ?? false);
  await click("Create Key");
  await type("api-key-name", "CI");
  await act(async () => submit().click());
  await waitFor(() => !!container.querySelector('[data-testid="api-key-secret"]'));
}

test("copying confirms in the button and a status line", async () => {
  const written: string[] = [];
  Object.defineProperty(browser.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void written.push(text) },
  });
  await createKey();
  await click("Copy API Key");
  await waitFor(
    () => container.querySelector('[role="status"]')?.textContent === "Copied to clipboard.",
  );
  expect(written).toEqual([secret]);
  expect(button("Copy API Key").textContent).toContain("Copied");
});

test("without a clipboard the key is selected and the user is told to copy it by hand", async () => {
  Object.defineProperty(browser.navigator, "clipboard", { configurable: true, value: undefined });
  await createKey();
  await click("Copy API Key");
  await waitFor(
    () => container.querySelector('[role="status"]')?.textContent?.includes("press") ?? false,
  );
  expect(button("Copy API Key").textContent).toContain("Copy");
  expect(button("Copy API Key").textContent).not.toContain("Copied");
  expect(String(browser.getSelection())).toBe(secret);
});
