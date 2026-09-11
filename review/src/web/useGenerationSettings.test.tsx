import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useGenerationSettings } from "./useGenerationSettings";

test("generation defaults select compatible credentials and remember choices within each repository", async () => {
  const browser = new Window({ url: "https://selfbench.test" });
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
  const root = createRoot(document.createElement("div"));
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  let empty = false;
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (
    _input: Parameters<typeof globalThis.fetch>[0],
  ) =>
    Response.json({
      models: ["gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-luna"],
      sandboxes: ["modal", "docker", "e2b"],
      available: true,
      credentials: empty
        ? []
        : [
            { id: id(1), kind: "openai", auth: "codex-login", name: "Codex" },
            { id: id(2), kind: "anthropic", auth: "api-key", name: "Anthropic" },
            { id: id(3), kind: "openai", auth: "api-key", name: "OpenAI" },
            { id: id(4), kind: "modal", auth: "api-key", name: "Modal" },
            { id: id(5), kind: "openai", auth: "api-key", name: "Other OpenAI" },
            { id: id(6), kind: "e2b", auth: "api-key", name: "E2B" },
          ],
    })) as typeof globalThis.fetch);
  let current!: ReturnType<typeof useGenerationSettings>;
  function Probe({ org, repo, enabled }: { org: string; repo: string; enabled: boolean }) {
    current = useGenerationSettings(org, repo, enabled);
    return null;
  }
  const render = (org = "team", repo = "owner/repo", enabled = true) =>
    act(async () => {
      root.render(<Probe org={org} repo={repo} enabled={enabled} />);
    });
  try {
    await render();
    expect(current.valid).toBe(true);
    expect(current.settings).toEqual({
      authorModel: "gpt-5.6-sol",
      verifierModel: "gpt-5.6-sol",
      reasoning: "high",
      sandbox: "modal",
      modelCredentialId: id(3),
      sandboxCredentialId: id(4),
    });
    await act(async () =>
      current.setSettings({
        ...current.settings,
        sandbox: "e2b",
        sandboxImage: "selfbench-test",
        harborEnvironment: "docker",
      }),
    );
    expect(current.settings.sandboxCredentialId).toBe(id(6));
    expect(current.valid).toBe(true);
    await act(async () => current.setSettings({ ...current.settings, sandbox: "modal" }));
    expect(current.settings.sandboxCredentialId).toBe(id(4));
    const chosen: typeof current.settings = {
      ...current.settings,
      authorModel: "gpt-6-astra",
      verifierModel: "gpt-5.6-luna",
      reasoning: "low" as const,
      sandbox: "docker" as const,
      modelCredentialId: id(5),
    };
    await act(async () => current.setSettings(chosen));
    await act(async () => root.render(null));
    await render();
    expect(current.settings).toEqual(chosen);
    expect(current.valid).toBe(true);
    await render("other-team");
    expect(current.settings.authorModel).toBe("gpt-5.6-sol");
    expect(current.settings.modelCredentialId).toBe(id(3));
    await render("team", "owner/other");
    expect(current.settings.authorModel).toBe("gpt-5.6-sol");
    await render();
    expect(current.settings).toEqual(chosen);
    // Reopening reads choices saved by the other generation dialog.
    await render("team", "owner/repo", false);
    browser.localStorage.setItem(
      "selfbench-generation:team:owner/repo",
      JSON.stringify({ ...chosen, reasoning: "medium" }),
    );
    await render();
    expect(current.settings.reasoning).toBe("medium");
    empty = true;
    await act(async () => browser.dispatchEvent(new browser.Event("focus")));
    expect(current.valid).toBe(false);
    expect(current.settings.modelCredentialId).toBe(id(5));
    await render("empty-team");
    expect(current.valid).toBe(false);
    expect(current.settings.modelCredentialId).toBe("");
    empty = false;
    browser.localStorage.setItem("selfbench-generation:corrupt:owner/repo", "{invalid");
    await render("corrupt");
    expect(current.valid).toBe(true);
    expect(current.settings.modelCredentialId).toBe(id(3));
  } finally {
    await act(async () => root.unmount());
    fetch.mockRestore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await browser.happyDOM.close();
  }
});
