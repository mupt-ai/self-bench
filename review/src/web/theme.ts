export type Theme = "light" | "dark";

export const THEME_KEY = "selfbench-theme";

/** Light unless the visitor chose dark here before. The system setting is not consulted. */
export function readTheme(storage: Pick<Storage, "getItem"> | undefined): Theme {
  try {
    return storage?.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(
  root: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void },
  theme: Theme,
): void {
  if (theme === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
}

export function rememberTheme(storage: Pick<Storage, "setItem"> | undefined, theme: Theme): void {
  try {
    storage?.setItem(THEME_KEY, theme);
  } catch {
    // Private windows and blocked storage: the choice lasts until the next load.
  }
}
