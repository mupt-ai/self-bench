import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CreditGrant } from "./CreditGrant";

let browser: Window;
let root: Root;
let container: HTMLDivElement;
let restore: () => void;
let responses: Response[];
let requests: { requestId: string; targetOrg: string; amountCents: number; reason: string }[];

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
  responses = [];
  requests = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return responses.shift() ?? Response.json({ error: "unexpected" }, { status: 500 });
  }) as typeof globalThis.fetch);
  Object.defineProperty(browser, "confirm", { configurable: true, value: () => true });
  restore = () => {
    fetch.mockRestore();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<CreditGrant org="mupt-ai" />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  restore();
  await browser.happyDOM.close();
});

async function type(index: number, value: string) {
  const input = container.querySelectorAll<HTMLInputElement>("input")[index];
  if (!input) throw new Error("Missing input");
  Object.assign(input, { attachEvent() {}, detachEvent() {} });
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  const event = (name: string) => new browser.Event(name, { bubbles: true }) as unknown as Event;
  await act(async () => input.dispatchEvent(event("focusin")));
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(event("input"));
    input.dispatchEvent(event("keyup"));
  });
}

async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}

test("pending credit survives reload, retries the same request, and only confirms a Stripe transaction", async () => {
  responses.push(Response.json({ pending: true, requestId: "wrong" }, { status: 202 }));
  await type(0, "team");
  await type(1, "25.00");
  await type(2, "Courtesy");
  await click("Grant Credit");
  const first = requests[0];
  expect(first?.amountCents).toBe(2500);
  expect(container.textContent).toContain("Unresolved credit");
  expect(container.textContent).not.toContain("Credit granted in Stripe");
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<CreditGrant org="mupt-ai" />));
  expect(container.textContent).toContain("Unresolved credit");
  expect(container.textContent).not.toContain("Grant Credit");
  responses.push(Response.json({ pending: true, requestId: first?.requestId }, { status: 202 }));
  await click("Retry Same Request");
  expect(requests[1]).toEqual(first);
  expect(container.textContent).not.toContain("Credit granted in Stripe");
  responses.push(Response.json({ id: "cbtxn_123" }));
  await click("Retry Same Request");
  expect(requests[2]).toEqual(first);
  expect(container.textContent).toContain("Credit granted in Stripe");
  expect(browser.sessionStorage.getItem("selfbench.billing.pending-credit.mupt-ai")).toBeNull();
});
