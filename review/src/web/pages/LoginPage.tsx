import { ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { Lockup } from "../Lockup";
import { useDocumentTitle, useSession } from "../session";
import { ThemeToggle } from "../ThemeToggle";
import { buttonStyles, Notice } from "../ui";
import { WaterBackground } from "../WaterBackground";

/** Rulers sit a proportional margin in from each window edge, as on selfbench.dev. */
const RULER_WIDTH = "w-[calc(100%-2*clamp(24px,6vw,160px))]";
const EDGE_FRAME = "mx-auto w-[calc(100%-2*clamp(24px,6vw,160px))] px-6";

const ERRORS: Record<string, string> = {
  state: "That sign-in attempt expired. Try again.",
  denied: "GitHub sign-in was cancelled.",
  github: "GitHub sign-in failed. Try again.",
  organization: "This deployment is limited to members of approved GitHub organizations.",
};

export function LoginPage() {
  useDocumentTitle("Sign In · SelfBench");
  const { session } = useSession();
  const [params] = useSearchParams();
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    const reset = () => setConnecting(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  const error = params.get("error");
  if (session.status === "signed-in") return <Navigate to="/" replace />;
  return (
    <div className="relative isolate flex h-dvh flex-col bg-transparent text-foreground">
      <WaterBackground />
      <div
        aria-hidden="true"
        className={`pointer-events-none fixed inset-y-0 left-1/2 z-10 ${RULER_WIDTH} -translate-x-1/2 border-x border-foreground/10`}
      />
      <header className="shrink-0 border-b border-border">
        <div className={`${EDGE_FRAME} flex h-16 items-center justify-between gap-4`}>
          <Lockup />
          <ThemeToggle />
        </div>
      </header>
      <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-12">
        <div className="panel w-full max-w-sm p-8">
          <h1 className="text-2xl font-semibold tracking-tight">Sign In</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Build private evals from your repository&apos;s history and find which model is best for
            it.
          </p>
          <a
            className={`${buttonStyles.primary} mt-7 h-10 w-full [&_svg]:fill-current`}
            href="/auth/github"
            aria-busy={connecting}
            aria-disabled={connecting}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              if (connecting) {
                event.preventDefault();
                return;
              }
              setConnecting(true);
            }}
          >
            {connecting ? (
              <span
                aria-hidden="true"
                className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
              />
            ) : (
              <GitHubMark />
            )}
            <span aria-live="polite">
              {connecting ? "Connecting to GitHub…" : "Continue with GitHub"}
            </span>
          </a>
          {error && (
            <Notice className="mt-5 w-full text-left">{ERRORS[error] ?? ERRORS.github}</Notice>
          )}
        </div>
      </main>
      <footer className="shrink-0 border-t border-border">
        <div
          className={`${EDGE_FRAME} flex items-center justify-between gap-3 py-4 font-mono text-xs font-semibold text-foreground/90`}
        >
          <a href="https://selfbench.dev" className="hover:text-foreground">
            selfbench.dev
          </a>
          <span className="flex gap-4">
            <OutLink href="https://dari.dev">dari.dev</OutLink>
            <OutLink href="https://github.com/mupt-ai/self-bench">GitHub</OutLink>
          </span>
        </div>
      </footer>
    </div>
  );
}

function OutLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 hover:text-foreground"
    >
      {children}
      <ArrowUpRight className="size-3" aria-hidden="true" />
    </a>
  );
}

function GitHubMark() {
  return (
    <svg className="size-4 shrink-0" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
