import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CredentialEditor } from "./CredentialEditor";

const base = "/api/orgs/test/credentials/codex-login";
const saved = { id: "credential", name: "Codex", kind: "openai", auth: "codex-login" };
const session = (id: string, status = "waiting") => ({
  id,
  status,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  instructions: { userCode: "TEST-CODE", verificationUrl: "https://auth.openai.com/codex/device" },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let browser: Window;
let root: Root;
let container: HTMLDivElement;
let restoreGlobals: () => void;
let requests: string[];
let respond: (path: string, method: string) => Response | Promise<Response>;
let restoreFetch: () => void;
const onSaved = mock(async () => {});
const onCancel = mock(() => {});

beforeEach(async () => {
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
  restoreGlobals = () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  requests = [];
  respond = () => Response.json({});
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${path}`);
    return respond(path, method);
  }) as typeof globalThis.fetch);
  restoreFetch = () => fetch.mockRestore();
  onSaved.mockClear();
  onCancel.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <CredentialEditor
        org="test"
        auth="codex-login"
        onSave={async () => {}}
        onSaved={onSaved}
        onCancel={onCancel}
      />,
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  restoreFetch();
  restoreGlobals();
  await browser.happyDOM.close();
});

function button(label: string) {
  const result = [...container.querySelectorAll("button")].find(
    (item) => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
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

test("restarting after a polling error does not revive the cancelled attempt", async () => {
  const restart = deferred<Response>();
  let starts = 0;
  respond = (path) => {
    if (path === base) {
      starts += 1;
      return starts === 1 ? Response.json(session("old")) : restart.promise;
    }
    if (path === `${base}/old`)
      return Response.json({ error: "Could not check sign-in" }, { status: 410 });
    if (path === `${base}/new`) return Response.json(session("new", "ready"));
    if (path.endsWith("/complete")) return Response.json(saved);
    return Response.json({});
  };
  await click("Sign In with ChatGPT");
  await waitFor(() => !!container.querySelector('[role="alert"]'));
  await click("Start Again");
  // The server waits for the old Codex process to close before returning the new session.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 650)));
  expect(requests.filter((request) => request === `GET ${base}/old`)).toHaveLength(1);
  await act(async () => restart.resolve(Response.json(session("new"))));
  await waitFor(() => onSaved.mock.calls.length === 1);
  expect(container.textContent).toContain("Codex Connected");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("dismissal waits for the approved credential to save and refresh the list", async () => {
  const saving = deferred<Response>();
  respond = (path) => {
    if (path === base) return Response.json(session("approved"));
    if (path.endsWith("/complete")) return saving.promise;
    return Response.json(session("approved", "ready"));
  };
  await click("Sign In with ChatGPT");
  await waitFor(() => requests.includes(`POST ${base}/approved/complete`));
  expect(button("Close").disabled).toBe(true);
  expect(button("Cancel Sign-In").disabled).toBe(true);
  await click("Close");
  await click("Cancel Sign-In");
  const cancel = new browser.Event("cancel", { cancelable: true });
  await act(async () => browser.document.querySelector("dialog")?.dispatchEvent(cancel));
  expect(cancel.defaultPrevented).toBe(true);
  expect(onCancel).not.toHaveBeenCalled();
  expect(requests.some((request) => request.endsWith("/cancel"))).toBe(false);
  await act(async () => saving.resolve(Response.json(saved)));
  await waitFor(() => onSaved.mock.calls.length === 1);
  expect(button("Close").disabled).toBe(false);
  expect(container.textContent).toContain("Codex Connected");
});

test("a failed save unlocks dismissal and can retry the approved session", async () => {
  let saves = 0;
  respond = (path) => {
    if (path === base) return Response.json(session("approved"));
    if (path.endsWith("/complete")) {
      saves += 1;
      return saves === 1
        ? Response.json({ error: "Storage unavailable. Retry saving." }, { status: 503 })
        : Response.json(saved);
    }
    return Response.json(session("approved", "ready"));
  };
  await click("Sign In with ChatGPT");
  await waitFor(() => !!container.querySelector('[role="alert"]'));
  expect(button("Close").disabled).toBe(false);
  expect(button("Cancel Sign-In").disabled).toBe(false);
  expect(onSaved).not.toHaveBeenCalled();
  await click("Retry");
  await waitFor(() => onSaved.mock.calls.length === 1);
  expect(saves).toBe(2);
});
