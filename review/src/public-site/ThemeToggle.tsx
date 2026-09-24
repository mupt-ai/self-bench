import { Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { sharedPreferences } from "./preferences";
import { applyTheme, rememberTheme, settleTheme, systemTheme, type Theme } from "./theme";

/** Shared with app.selfbench.dev, so the choice carries across (see preferences.ts). */
const storage = () => sharedPreferences();

/**
 * Light or dark, for selfbench.dev and the app alike. Follows the system until the visitor
 * picks one; a later system change is followed once, even while the page is open.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(() => settleTheme(storage(), systemTheme()));
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => {
      const next = settleTheme(storage(), systemTheme());
      applyTheme(document.documentElement, next);
      setTheme(next);
    };
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);
  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(document.documentElement, next);
    rememberTheme(storage(), next, systemTheme());
    setTheme(next);
  }, [theme]);
  const label = theme === "dark" ? "Switch to Light Theme" : "Switch to Dark Theme";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={`group hit relative inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:bg-foreground/[0.06] ${className}`}
    >
      <FillIcon Icon={theme === "dark" ? Sun : Moon} />
    </button>
  );
}

/** The outline icon, with a filled copy that rises from the bottom on hover. */
function FillIcon({ Icon }: { Icon: typeof Sun }) {
  return (
    <span className="relative size-4" aria-hidden="true">
      <Icon className="absolute inset-0 size-4" />
      <Icon
        fill="currentColor"
        className="absolute inset-0 size-4 transition-[clip-path] duration-300 ease-out [clip-path:inset(100%_0_0_0)] group-hover:[clip-path:inset(0_0_0_0)] group-focus-visible:[clip-path:inset(0_0_0_0)]"
      />
    </span>
  );
}
