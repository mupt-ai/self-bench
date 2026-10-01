import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { SetupPage } from "./SetupPage";
import { SetupStatusContext } from "./SetupStatus";

const claude: CredentialInfo = {
  id: "claude",
  name: "Claude",
  kind: "anthropic",
  auth: "claude-login",
  createdAt: "",
};

let browser: Window;
let container: HTMLDivElement;
let root: Root;
let restore: () => void;
let posts: { url: string; body: unknown }[];
const refresh = mock(async () => {});

beforeEach(() => {
  browser = new Window({ url: "https://selfbench.test" });
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
  posts = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    posts.push({ url: String(input), body: JSON.parse(String(init?.body ?? "null")) });
    return Response.json({});
  }) as typeof globalThis.fetch);
  restore = () => {
    fetch.mockRestore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  refresh.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  restore();
  await browser.happyDOM.close();
});

async function render(path: string, credentials: CredentialInfo[], canManage: boolean) {
  await act(async () => {
    root.render(
      <SetupStatusContext.Provider value={{ credentials, canManage, incomplete: true, refresh }}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<Outlet context={{ org: { login: "team" }, orgs: [] }} />}>
              <Route path="/get-started" element={<SetupPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </SetupStatusContext.Provider>,
    );
  });
}

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);

async function click(label: string) {
  const found = button(label);
  if (!found) throw new Error(`Missing button: ${label}`);
  await act(async () => found.click());
}

/** React's legacy change detection in these tests: focus, set the value, then key up. */
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

test("a Claude sign-in alone evaluates but cannot generate, and each step opens its own flow", async () => {
  await render("/get-started", [claude], true);
  const generate = [...container.querySelectorAll("dt")].find((item) =>
    item.textContent?.startsWith("Generate Tasks"),
  )?.parentElement?.textContent;
  expect(generate).toContain("Not Ready");
  expect(generate).toContain("Needs a ChatGPT sign-in or a model API key.");
  expect(button("Sign In with Claude")).toBeUndefined();

  await click("Sign In with ChatGPT");
  expect(container.querySelector("dialog")?.open).toBe(true);
  expect(button("ChatGPT Sign-In")?.getAttribute("aria-pressed")).toBe("true");
  await click("Cancel");

  await click("Add E2B");
  expect(container.querySelector<HTMLSelectElement>("#credential-provider")?.value).toBe("e2b");
  await type("credential-name", "Team E2B");
  await type("credential-secret", "e2b_key");
  await act(async () => {
    container
      .querySelector("form")
      ?.dispatchEvent(
        new browser.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
      );
  });
  expect(posts).toEqual([
    {
      url: "/api/orgs/team/credentials",
      body: { name: "Team E2B", kind: "e2b", auth: "api-key", value: "e2b_key" },
    },
  ]);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(container.querySelector("dialog")).toBeNull();
});

test("members see the checklist without actions, and the finish links back to the blocked page", async () => {
  await render("/get-started?return=%2Frepos%2Fowner%2Frepo%2Frun", [], false);
  expect(container.textContent).toContain("Only admins can connect credentials.");
  expect(button("Sign In with ChatGPT")).toBeUndefined();
  expect(button("Add Modal")).toBeUndefined();
  const back = [...container.querySelectorAll("a")].filter(
    (link) => link.textContent === "Back to Run",
  );
  expect(back.length).toBeGreaterThan(0);
  expect(back.every((link) => link.getAttribute("href") === "/repos/owner/repo/run")).toBe(true);
});
