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
let bodies: unknown[];
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
  bodies = [];
  respond = () => Response.json({});
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${path}`);
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
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
    if (path === `${base}/new`)
      return Response.json({ ...session("new", "saved"), credential: saved });
    return Response.json({});
  };
  await click("Sign In with ChatGPT");
  await waitFor(() => !!container.querySelector('[role="alert"]'));
  await click("Start Again");
  // The new session is still starting when the old one's poll would have fired.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 650)));
  expect(requests.filter((request) => request === `GET ${base}/old`)).toHaveLength(1);
  await act(async () => restart.resolve(Response.json(session("new"))));
  await waitFor(() => onSaved.mock.calls.length === 1);
  expect(container.textContent).toContain("Codex Connected");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("the server saves the approved credential; the browser only polls", async () => {
  respond = (path) =>
    path === base
      ? Response.json(session("approved"))
      : Response.json({ ...session("approved", "saved"), credential: saved });
  await click("Sign In with ChatGPT");
  await waitFor(() => onSaved.mock.calls.length === 1);
  expect(container.textContent).toContain("Codex Connected");
  expect(requests).toEqual([`POST ${base}`, `GET ${base}/approved`]);
});

const claudeBase = "/api/orgs/test/credentials/claude-login";
async function renderClaude(onSave = async (_draft: unknown) => {}) {
  await act(async () =>
    root.render(
      <CredentialEditor
        key="claude"
        org="test"
        kind="anthropic"
        auth="claude-login"
        onSave={onSave}
        onSaved={onSaved}
        onCancel={onCancel}
      />,
    ),
  );
}
async function type(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`Missing field: ${id}`);
  // React's legacy change detection here: it watches the focused element and compares on keyup.
  Object.assign(input, { attachEvent() {}, detachEvent() {} });
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  const event = (name: string) => new browser.Event(name, { bubbles: true }) as unknown as Event;
  await act(async () => input.dispatchEvent(event("focusin")));
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(event("keyup"));
  });
}

test("Claude sign-in warns it is Claude Code only and hands the pasted code to the server", async () => {
  const authorizeUrl = "https://claude.com/cai/oauth/authorize?state=s";
  respond = (path) =>
    path === claudeBase
      ? Response.json({ id: "attempt", status: "waiting", expiresAt: "", authorizeUrl })
      : Response.json({
          id: "attempt",
          status: "saved",
          expiresAt: "",
          credential: { ...saved, kind: "anthropic", auth: "claude-login" },
        });
  await renderClaude();
  expect(container.textContent).toContain("only works with the Claude Code harness");
  await click("Sign In with Claude");
  await waitFor(() => !!container.querySelector("#claude-code"));
  expect(container.querySelector("a")?.getAttribute("href")).toBe(authorizeUrl);
  await type("claude-code", "the-code#s");
  await click("Connect");
  await waitFor(() => onSaved.mock.calls.length === 1);
  expect(container.textContent).toContain("Claude Connected");
  expect(requests).toEqual([`POST ${claudeBase}`, `POST ${claudeBase}/attempt/complete`]);
  expect(bodies.at(-1)).toEqual({ code: "the-code#s" });
});

test("a pasted setup token is saved without the line breaks a terminal adds", async () => {
  const onSave = mock(async (_draft: unknown) => {});
  await renderClaude(onSave);
  await click("Paste a Setup Token");
  await type("credential-secret", "sk-ant-oat01-abc\n  def");
  await act(async () => button("Save").click());
  expect(onSave.mock.calls[0]?.[0]).toMatchObject({
    kind: "anthropic",
    auth: "claude-login",
    value: "sk-ant-oat01-abcdef",
  });
});
