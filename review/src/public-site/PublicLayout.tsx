import { type ComponentType, lazy, Suspense, useEffect, useRef } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import { OutLink } from "./components/OutLink";
import { CursorAura } from "./effects/CursorAura";
import { notePath } from "./effects/history-transitions";
import { lineOf, scrollRoot, select } from "./effects/marks";
import { returnHome } from "./effects/page-return";
import { plainClick } from "./effects/page-reveal";
import { WaterBackground } from "./effects/WaterBackground";
import { EDGE_FRAME, FRAME, RULER_WIDTH } from "./frame";
import { followJourney, homeView, journeyFrom, repositoryOf } from "./home-view";
import { SettingsMenu } from "./SettingsMenu";
import { ThemeToggle } from "./ThemeToggle";

export const APP_URL = "https://app.selfbench.dev";

/**
 * Optional style widgets for trying palettes and effects: a local-only file, not in the
 * repository, loaded by the dev server when present and never included in the build.
 */
// Looked up only on the dev server: outside Vite (in tests) import.meta.glob does not exist.
const styleLab = import.meta.env.DEV
  ? import.meta.glob<{ default: ComponentType }>("./dev/StyleLab.tsx")["./dev/StyleLab.tsx"]
  : undefined;
const StyleLab = styleLab ? lazy(styleLab) : undefined;

/**
 * The frame every public page shares. Only the middle scrolls, so the header and footer keep
 * a constant size. Two ruler lines run the full height at the frame's edges.
 */
export function PublicLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => notePath(location.pathname), [location.pathname]);
  // Tracks the trip from the home page, entry by entry (see `followJourney`).
  const previousKey = useRef<string>(undefined);
  useEffect(() => {
    const repository = repositoryOf(location.pathname);
    if (repository) followJourney(location.key, repository, previousKey.current);
    previousKey.current = location.key;
  }, [location.key, location.pathname]);

  // From a repository page, SELF-BENCH plays the return. If the visitor came from the home
  // page on this trip, it goes back to that home view (search and scroll); otherwise to the top.
  const goHome = (event: React.MouseEvent) => {
    const repository = repositoryOf(location.pathname);
    if (!repository || !plainClick(event)) return;
    event.preventDefault();
    const entry = journeyFrom(location.key, repository);
    const query = homeView(entry)?.query;
    const shown = document.querySelector(select.shownLine);
    returnHome(shown ? lineOf(shown) : repository, () =>
      navigate(
        { pathname: "/", search: query ? `?q=${encodeURIComponent(query)}` : "" },
        { state: entry ? { restoreFrom: entry } : undefined },
      ),
    );
  };
  return (
    <div className="relative isolate flex h-dvh flex-col text-foreground">
      <WaterBackground />
      <CursorAura />
      {/* Referenced by theme.css to tint logos in dark mode: channels scaled, blue kept most. */}
      <svg aria-hidden="true" className="absolute size-0">
        <filter id="ink-cast" colorInterpolationFilters="sRGB">
          <feColorMatrix
            type="matrix"
            values="0.72 0 0 0 0  0 0.78 0 0 0  0 0 0.88 0 0  0 0 0 1 0"
          />
        </filter>
      </svg>
      <div
        aria-hidden="true"
        className={`pointer-events-none fixed inset-y-0 left-1/2 z-10 ${RULER_WIDTH} -translate-x-1/2 border-x border-(--ruler)`}
      />
      <header className="shrink-0 border-b border-border">
        <div className={`${EDGE_FRAME} flex h-16 items-center justify-between gap-4`}>
          <Link
            to="/"
            onClick={goHome}
            aria-label="SELF-BENCH Home"
            className="font-mono text-xl font-bold tracking-wider"
          >
            SELF-BENCH
          </Link>
          <nav aria-label="Site" className="flex items-center gap-3 text-sm">
            {StyleLab && (
              <Suspense fallback={null}>
                <StyleLab />
              </Suspense>
            )}
            <a
              href={APP_URL}
              className="font-semibold text-foreground/80 underline decoration-foreground/30 underline-offset-4 hover:text-foreground hover:decoration-foreground"
            >
              Sign In
            </a>
            {/*
              The icons sit in 32px buttons with 8px of space around each glyph. Grouped 4px
              apart, every visible gap in the nav comes out at 20px, and pulling the group out
              by 8px puts the last glyph on the frame edge.
            */}
            <span className="-mr-2 flex items-center gap-1">
              <ThemeToggle />
              <SettingsMenu />
            </span>
          </nav>
        </div>
      </header>
      <div
        {...scrollRoot}
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]"
      >
        <main className={`${FRAME} py-10`}>
          <Outlet />
        </main>
        {/* Content passing under the footer softens slightly instead of being cut off hard. */}
        <div
          aria-hidden="true"
          className="pointer-events-none sticky bottom-0 -mt-6 h-6 backdrop-blur-[1.5px] [mask-image:linear-gradient(to_top,black,transparent)]"
        />
      </div>
      <footer className="shrink-0 border-t border-border">
        <div
          className={`${EDGE_FRAME} flex items-center justify-between gap-3 py-4 font-mono text-xs font-semibold text-foreground/90`}
        >
          <span>selfbench.dev</span>
          <span className="flex gap-4">
            <OutLink href="https://dari.dev">dari.dev</OutLink>
            <OutLink href="https://github.com/mupt-ai/self-bench">GitHub</OutLink>
          </span>
        </div>
      </footer>
    </div>
  );
}
