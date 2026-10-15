import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CredentialDraft } from "../../../../src/db/credentials";
import { CredentialSecret } from "./CredentialSecret";

test("OpenRouter billing access is an optional password field and is absent for other providers", async () => {
  const browser = new Window({ url: "http://localhost" });
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let draft: CredentialDraft = {
    name: "OpenRouter",
    kind: "openrouter",
    auth: "api-key",
    value: "inference",
  };
  const render = () =>
    root.render(
      <CredentialSecret
        draft={draft}
        setDraft={(next) => {
          draft = typeof next === "function" ? next(draft) : next;
        }}
        importing={false}
        setError={() => {}}
        keyLabel="API Key"
      />,
    );
  try {
    await act(async () => render());
    const field = container.querySelector<HTMLInputElement>("#credential-management-key");
    expect(field?.type).toBe("password");
    expect(field?.required).toBe(false);
    expect(container.textContent).toContain("never sent to a solver");
    draft = { ...draft, kind: "openai" };
    await act(async () => render());
    expect(container.querySelector("#credential-management-key")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    browser.happyDOM.abort();
  }
});
