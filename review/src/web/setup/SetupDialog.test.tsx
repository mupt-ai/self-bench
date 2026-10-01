import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { SetupDialog } from "./SetupDialog";

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
const onClose = mock(() => {});

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
    // A sign-in start that never resolves keeps the flow on its preparing state.
    if (String(input).endsWith("/codex-login")) return new Promise<Response>(() => {});
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
  onClose.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  restore();
  await browser.happyDOM.close();
});

async function render(credentials: CredentialInfo[], canManage = true) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SetupDialog
          org="team"
          credentials={credentials}
          canManage={canManage}
          refresh={refresh}
          onClose={onClose}
        />
      </MemoryRouter>,
    );
  });
}

const heading = () => container.querySelector("#setup-title")?.textContent;
const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (item) => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label,
  );

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

test("a new org starts at the coding plan, and Connect begins that plan's sign-in", async () => {
  await render([]);
  expect(heading()).toBe("Connect a Coding Plan");
  expect(button("Skip for Now")).toBeDefined();
  await click("Connect ChatGPT");
  expect(posts).toEqual([
    { url: "/api/orgs/team/credentials/codex-login", body: { name: "Codex" } },
  ]);
});

test("after a Claude sign-in, a sandbox finishes evaluation but generation still needs ChatGPT", async () => {
  await render([claude]);
  expect(heading()).toBe("Choose Where Tasks Run");
  await click("Connect Modal");
  await type("setup-token-id", "ak-1");
  await type("setup-secret", "as-1");
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
      body: { name: "Modal", kind: "modal", auth: "api-key", value: "as-1", tokenId: "ak-1" },
    },
  ]);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(heading()).toBe("Almost There");
  expect(container.textContent).toContain("Needs a ChatGPT sign-in or a model API key.");
});

test("members see what is missing and who can connect it, without connect actions", async () => {
  await render([], false);
  expect(heading()).toBe("Setup Needs an Admin");
  expect(button("Connect ChatGPT")).toBeUndefined();
  await click("Done");
  expect(onClose).toHaveBeenCalledTimes(1);
});
