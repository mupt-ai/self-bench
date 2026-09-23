export type Theme = "light" | "dark";

/** The theme the visitor is shown, saved in the shared preferences (see preferences.ts). */
export const THEME_KEY = "selfbench-theme";
/** The system theme when that was last settled, so a later system change can be noticed. */
export const SYSTEM_KEY = "selfbench-system";

type Preferences = Pick<Storage, "getItem" | "setItem">;

const themeOf = (value: string | null | undefined): Theme | undefined =>
  value === "dark" || value === "light" ? value : undefined;

/** The operating system's light or dark setting. */
export function systemTheme(): Theme {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * The theme to show, saved for next time. A first visit follows the system. A choice made with
 * the toggle holds until the system theme changes; that change wins once, and the toggle can
 * override it again. A choice saved before the system was recorded is kept. The same rule runs
 * before first paint in both sites' index.html.
 */
export function settleTheme(preferences: Preferences | undefined, system: Theme): Theme {
  let saved: Theme | undefined;
  let seen: Theme | undefined;
  try {
    saved = themeOf(preferences?.getItem(THEME_KEY));
    seen = themeOf(preferences?.getItem(SYSTEM_KEY));
  } catch {
    // Blocked storage: follow the system.
  }
  const theme = saved && (seen === undefined || seen === system) ? saved : system;
  if (theme !== saved || seen !== system) rememberTheme(preferences, theme, system);
  return theme;
}

export function applyTheme(
  root: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void },
  theme: Theme,
): void {
  if (theme === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
}

/** Saves the theme with the system theme it was chosen under. */
export function rememberTheme(
  preferences: Preferences | undefined,
  theme: Theme,
  system: Theme,
): void {
  try {
    preferences?.setItem(THEME_KEY, theme);
    preferences?.setItem(SYSTEM_KEY, system);
  } catch {
    // Private windows and blocked storage: the choice lasts until the next load.
  }
}
