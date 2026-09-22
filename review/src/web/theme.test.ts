import { expect, test } from "bun:test";
import { applyTheme, readTheme, rememberTheme, THEME_KEY } from "./theme";

function storage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    store,
  };
}

test("light is the default and only an explicit dark choice changes it", () => {
  expect(readTheme(undefined)).toBe("light");
  expect(readTheme(storage())).toBe("light");
  expect(readTheme(storage({ [THEME_KEY]: "dark" }))).toBe("dark");
  expect(readTheme(storage({ [THEME_KEY]: "system" }))).toBe("light");
});

test("blocked storage never throws", () => {
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  expect(readTheme(broken)).toBe("light");
  expect(() => rememberTheme(broken, "dark")).not.toThrow();
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
  const saved = storage();
  rememberTheme(saved, "dark");
  expect(saved.store.get(THEME_KEY)).toBe("dark");
});
