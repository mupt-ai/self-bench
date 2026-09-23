import { Moon, Sun } from "lucide-react";
import { useCallback, useState } from "react";
import { sharedPreferences } from "../public-site/preferences";
import { applyTheme, readTheme, rememberTheme, type Theme } from "../public-site/theme";
import { cn } from "./primitives/cn";

/** Shared with selfbench.dev, so the choice carries across (see preferences.ts). */
const storage = () => sharedPreferences();

/** Light or dark, shared with selfbench.dev and applied before first paint by index.html. */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(() => readTheme(storage()));
  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(document.documentElement, next);
    rememberTheme(storage(), next);
    setTheme(next);
  }, [theme]);
  const label = theme === "dark" ? "Switch to Light Theme" : "Switch to Dark Theme";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={cn(
        "group inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:bg-foreground/[0.06]",
        className,
      )}
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
