import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as api from "./api";
import { ConnectRepoSheet } from "./ConnectRepoSheet";

test("connect sheet lists fetched repositories with a Connect action", async () => {
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
  const list = spyOn(api, "fetchGitHubRepos").mockResolvedValue([
    {
      githubId: 1,
      fullName: "avyayv/tunnel",
      name: "tunnel",
      private: false,
      archived: false,
      defaultBranch: "main",
    },
  ]);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <ConnectRepoSheet
          org={{ login: "avyayv", kind: "user", role: "admin" }}
          mode="mine"
          connected={new Set()}
          onClose={() => undefined}
          onConnected={() => undefined}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    const html = container.innerHTML;
    expect(html).toContain("avyayv/tunnel");
    expect(html).toContain("main");
    expect(html).toContain("Connect My Repo");
    expect(html).toContain(">Connect<");
  } finally {
    await act(async () => {
      root.unmount();
    });
    list.mockRestore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
