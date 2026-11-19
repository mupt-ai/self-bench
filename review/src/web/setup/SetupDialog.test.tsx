import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { SetupDialog } from "./SetupDialog";

const claude: CredentialInfo = {
  id: "claude",
  name: "Dari · a@example.com",
  kind: "dari-link",
  auth: "dari-link",
  createdAt: "",
  linkModels: { models: [{ id: "anthropic/claude-opus-5-5", only: "claude-code" }], prefixes: [] },
};
const chatgpt: CredentialInfo = {
  id: "chatgpt",
  name: "Dari · b@example.com",
  kind: "dari-link",
  auth: "dari-link",
  createdAt: "",
  linkModels: { models: [{ id: "openai/gpt-6-astra" }], prefixes: [] },
};
const modal: CredentialInfo = {
  id: "modal",
  name: "Modal",
  kind: "modal",
  auth: "api-key",
  createdAt: "",
};
const dariLink = {
  gatewayUrl: "https://routing.dari.test",
  clientId: "lnk_selfbench",
  redirectUri: "https://selfbench.test/api/dari-link/callback",
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

async function render(
  credentials: CredentialInfo[],
  canManage = true,
  config: typeof dariLink | null = dariLink,
) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SetupDialog
          org="team"
          credentials={credentials}
          canManage={canManage}
          dariLink={config}
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

test("a new org starts at Connect with Dari, the only way to connect a subscription", async () => {
  await render([]);
  expect(heading()).toBe("Connect Your AI Subscription");
  expect(button("Connect with Dari")).toBeDefined();
  expect(button("Skip for Now")).toBeDefined();
  // Nothing is pasted or signed in to here: keys and plans alike are connected on Dari.
  expect(container.querySelector("input, textarea")).toBeNull();
  expect(container.textContent).not.toContain("Sign-In");
});

test("without Dari Link on the deployment, the first step says so instead of offering a button", async () => {
  await render([], true, null);
  expect(button("Connect with Dari")).toBeUndefined();
  expect(container.textContent).toContain("isn't configured on this deployment");
});

test("after connecting a Claude plan, a sandbox finishes evaluation but not generation", async () => {
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
  expect(container.textContent).toContain(
    "Needs a model that can write tasks, such as a ChatGPT plan or an API key connected with Dari. Claude and Muse plans only run evaluations.",
  );
});

test("a ChatGPT plan connected with Dari, and a sandbox, is ready to generate and evaluate", async () => {
  await render([chatgpt, modal]);
  expect(heading()).toBe("You're Set");
  expect(container.textContent).not.toContain("Needs a model");
  expect(container.textContent).toContain("Ready.");
});

test("members see what is missing and who can connect it, without connect actions", async () => {
  await render([], false);
  expect(heading()).toBe("Setup Needs an Admin");
  expect(button("Connect with Dari")).toBeUndefined();
  await click("Done");
  expect(onClose).toHaveBeenCalledTimes(1);
});
