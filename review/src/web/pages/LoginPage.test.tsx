import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { LoginPage } from "./LoginPage";

test("GitHub sign-in shows progress, blocks repeat clicks, and resets on return", async () => {
  const browser = new Window({ url: "https://selfbench.test/login" });
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
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/login?error=denied"]}>
          <LoginPage />
        </MemoryRouter>,
      );
    });
    const link = browser.document.querySelector('a[href="/auth/github"]');
    if (!(link instanceof browser.HTMLAnchorElement))
      throw new Error("Missing GitHub sign-in link");
    expect(link.textContent).toBe("Continue with GitHub");
    expect(link.getAttribute("aria-busy")).toBe("false");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "GitHub sign-in was cancelled.",
    );

    // Observe whether React allows navigation, then stop happy-dom from following it.
    let navigationAllowed = false;
    container.addEventListener("click", (event) => {
      navigationAllowed = !event.defaultPrevented;
      event.preventDefault();
    });
    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) {
      await act(async () => {
        link.dispatchEvent(
          new browser.MouseEvent("click", { bubbles: true, cancelable: true, [modifier]: true }),
        );
      });
      expect(navigationAllowed).toBe(true);
      expect(link.getAttribute("aria-busy")).toBe("false");
    }

    await act(async () => link.click());
    expect(navigationAllowed).toBe(true);
    expect(link.textContent).toBe("Connecting to GitHub…");
    expect(link.getAttribute("aria-busy")).toBe("true");
    expect(link.getAttribute("aria-disabled")).toBe("true");
    expect(link.querySelector('.animate-spin[aria-hidden="true"]')).not.toBeNull();
    expect(link.querySelector('[aria-live="polite"]')?.textContent).toBe("Connecting to GitHub…");

    await act(async () => link.click());
    expect(navigationAllowed).toBe(false);

    await act(async () => browser.dispatchEvent(new browser.Event("pageshow")));
    expect(link.textContent).toBe("Continue with GitHub");
    expect(link.getAttribute("aria-busy")).toBe("false");
    expect(link.getAttribute("aria-disabled")).toBe("false");
    expect(link.querySelector(".animate-spin")).toBeNull();
    await act(async () => link.click());
    expect(navigationAllowed).toBe(true);
    expect(link.getAttribute("aria-busy")).toBe("true");
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await browser.happyDOM.close();
  }
});
