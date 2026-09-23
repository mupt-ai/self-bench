import { expect, test } from "bun:test";
import { applyTheme, rememberTheme, SYSTEM_KEY, settleTheme, THEME_KEY } from "./theme";

function storage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    store,
  };
}

test("a first visit follows the system and remembers what it saw", () => {
  const dark = storage();
  expect(settleTheme(dark, "dark")).toBe("dark");
  expect(dark.store.get(SYSTEM_KEY)).toBe("dark");
  expect(settleTheme(storage(), "light")).toBe("light");
  expect(settleTheme(undefined, "dark")).toBe("dark");
});

test("a toggled choice holds while the system theme stays the same", () => {
  const saved = storage();
  settleTheme(saved, "dark");
  rememberTheme(saved, "light", "dark");
  expect(settleTheme(saved, "dark")).toBe("light");
  expect(settleTheme(saved, "dark")).toBe("light");
});

test("a system change wins once, then the toggle can override it again", () => {
  // Dark system; toggled to light and back to dark; then the system turns light.
  const saved = storage();
  settleTheme(saved, "dark");
  rememberTheme(saved, "light", "dark");
  rememberTheme(saved, "dark", "dark");
  expect(settleTheme(saved, "light")).toBe("light");
  expect(saved.store.get(SYSTEM_KEY)).toBe("light");
  // Toggled back to dark under the light system: it holds until the system changes again.
  rememberTheme(saved, "dark", "light");
  expect(settleTheme(saved, "light")).toBe("dark");
  expect(settleTheme(saved, "dark")).toBe("dark");
  // A light choice under a dark system, then the system turns light: nothing to change.
  rememberTheme(saved, "light", "dark");
  expect(settleTheme(saved, "light")).toBe("light");
});

test("a choice saved before the system was recorded is kept", () => {
  const legacy = storage({ [THEME_KEY]: "dark" });
  expect(settleTheme(legacy, "light")).toBe("dark");
  expect(legacy.store.get(SYSTEM_KEY)).toBe("light");
  expect(settleTheme(storage({ [THEME_KEY]: "system" }), "light")).toBe("light");
});

test("blocked storage never throws and follows the system", () => {
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  expect(settleTheme(broken, "dark")).toBe("dark");
  expect(() => rememberTheme(broken, "dark", "light")).not.toThrow();
});

test("dark sets the attribute the stylesheet keys on and light removes it", () => {
  const attributes = new Map<string, string>();
  const root = {
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
  };
  applyTheme(root, "dark");
  expect(attributes.get("data-theme")).toBe("dark");
  applyTheme(root, "light");
  expect(attributes.has("data-theme")).toBe(false);
});
