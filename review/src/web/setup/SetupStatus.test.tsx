import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SetupStatusContext, useOrgCredentials, useSetupStatusSource } from "./SetupStatus";

let browser: Window;
let container: HTMLDivElement;
let root: Root;
let restore: () => void;
let canManage = true;
let credentials: { id: string; name: string; kind: string; auth: string }[] = [];

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
  canManage = true;
  credentials = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (_input: unknown) =>
    Response.json({ credentials, canManage })) as typeof globalThis.fetch);
  restore = () => {
    fetch.mockRestore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  restore();
  await browser.happyDOM.close();
});

function Probe({ org, managedOffering = false }: { org: string; managedOffering?: boolean }) {
  const setup = useSetupStatusSource(org, managedOffering);
  return <p>{setup.dialogOpen ? "open" : "closed"}</p>;
}

async function visit(org: string, managedOffering = false) {
  await act(async () =>
    root.render(<Probe key={org} org={org} managedOffering={managedOffering} />),
  );
  return container.textContent;
}

test("the setup popup opens on an admin's first visit to an org that is not set up", async () => {
  expect(await visit("team")).toBe("open");
  // Seen once in this browser: later visits leave it to the sidebar and callouts.
  await act(async () => root.render(<p />));
  expect(await visit("team")).toBe("closed");
  expect(await visit("other")).toBe("open");
});

test("the setup popup stays closed for members, set-up orgs, and the managed offering", async () => {
  canManage = false;
  expect(await visit("members")).toBe("closed");
  canManage = true;
  expect(await visit("managed", true)).toBe("closed");
  credentials = [
    { id: "a", name: "Codex", kind: "openai", auth: "codex-login" },
    { id: "b", name: "Modal", kind: "modal", auth: "api-key" },
  ];
  expect(await visit("ready")).toBe("closed");
});

function Form() {
  const [list] = useOrgCredentials("team");
  return <p>{list?.map((entry) => entry.name).join() ?? "loading"}</p>;
}

test("a form's credential list reloads when setup changes the org's credentials", async () => {
  const shared = (value: { name: string }[]) => (
    <SetupStatusContext.Provider
      value={{
        credentials: value as never,
        canManage: true,
        incomplete: true,
        refresh: async () => undefined,
        dialogOpen: false,
        openDialog: () => undefined,
        closeDialog: () => undefined,
      }}
    >
      <Form />
    </SetupStatusContext.Provider>
  );
  await act(async () => root.render(shared([])));
  expect(container.textContent).toBe("");
  credentials = [{ id: "b", name: "Modal", kind: "modal", auth: "api-key" }];
  await act(async () => root.render(shared(credentials)));
  expect(container.textContent).toBe("Modal");
});
