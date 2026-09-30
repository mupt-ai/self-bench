import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { RunPage } from "./RunPage";
import { restoreRunDraft } from "./run-draft";

const path = "/repos/owner/repo/run";
const url = "/api/orgs/team/repos/owner/repo/evaluations";
const key = `selfbench-run:${url}`;

test("Run defaults fresh drafts to an offered managed sandbox without replacing a saved or explicit choice", async () => {
  const browser = new Window({ url: "https://selfbench.test" });
  const globals = {
    window: browser,
    document: browser.document,
    sessionStorage: browser.sessionStorage,
    HTMLElement: browser.HTMLElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const container = document.createElement("div");
  document.body.append(container);
  const fetch = spyOn(globalThis, "fetch");
  const sandbox = () => container.querySelector<HTMLSelectElement>('select[aria-label="Sandbox"]');
  const choose = async (value: string) => {
    await act(async () => {
      const select = sandbox();
      if (!select) throw new Error("Missing sandbox selector");
      select.value = value;
      select.dispatchEvent(new browser.Event("change", { bubbles: true }) as unknown as Event);
    });
  };
  let root = createRoot(container);
  const mount = async (managed: boolean, catalog?: Promise<Response>) => {
    fetch.mockImplementation((async (input) => {
      const endpoint = String(input);
      if (endpoint === `${url}/catalog`)
        return (
          catalog ??
          Response.json({
            models: [],
            sandboxes: ["e2b", "modal"],
            managed: { models: false, sandbox: managed },
          })
        );
      if (endpoint === `${url}/options`) return Response.json({ tasks: [] });
      if (endpoint === "/api/orgs/team/credentials") return Response.json({ credentials: [] });
      throw new Error(`Unexpected request: ${endpoint}`);
    }) as typeof globalThis.fetch);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<Outlet context={{ org: { login: "team" }, orgs: [] }} />}>
              <Route path="/repos/:owner/:name/run" element={<RunPage />} />
            </Route>
          </Routes>
        </MemoryRouter>,
      );
    });
  };
  const reset = async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
  };
  try {
    await mount(true);
    expect(sandbox()?.value).toBe("managed");
    expect(container.querySelector('select[aria-label="Sandbox Credential"]')).toBeNull();
    expect(
      JSON.parse(browser.sessionStorage.getItem(key) ?? "null").draft.sandboxCredentialId,
    ).toBe("managed-sandbox");
    await choose("e2b");
    await reset();
    await mount(true);
    expect(sandbox()?.value).toBe("e2b");

    await reset();
    browser.sessionStorage.removeItem(key);
    await mount(false);
    expect(sandbox()?.value).toBe("e2b");
    expect(sandbox()?.querySelector('option[value="managed"]')).toBeNull();

    await reset();
    browser.sessionStorage.removeItem(key);
    const pendingCatalog = Promise.withResolvers<Response>();
    await mount(true, pendingCatalog.promise);
    const model = container.querySelector<HTMLSelectElement>('select[aria-label="Model"]');
    if (!model) throw new Error("Missing model selector");
    await act(async () => {
      model.value = "custom";
      model.dispatchEvent(new browser.Event("change", { bubbles: true }) as unknown as Event);
    });
    await act(async () =>
      pendingCatalog.resolve(
        Response.json({
          models: [],
          sandboxes: ["e2b", "modal"],
          managed: { models: false, sandbox: true },
        }),
      ),
    );
    expect(sandbox()?.value).toBe("managed");

    await reset();
    browser.sessionStorage.setItem(
      key,
      JSON.stringify({
        ...restoreRunDraft(null, null),
        submitted: true,
        sandboxDefaultPending: true,
      }),
    );
    await mount(true);
    expect(sandbox()?.value).toBe("e2b");
  } finally {
    await act(async () => root.unmount());
    fetch.mockRestore();
    container.remove();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await browser.happyDOM.close();
  }
});
