import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { OutLink } from "../../public-site/components/OutLink";
import { GitHubMark } from "../GitHubMark";
import { AppLockup } from "../Lockup";
import { useDocumentTitle, useSession } from "../session";
import { buttonStyles, Notice } from "../ui";

const PUBLIC_SITE_URL = "https://selfbench.dev";

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
  // As dari.dev's own sign-in: the wordmark over one square card, centred on the page.
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex justify-center">
            <AppLockup href={PUBLIC_SITE_URL} name="selfbench.dev" />
          </div>
          <div className="border border-border bg-card p-8">
            <h1 className="text-xl font-medium">Sign In</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Build private evals from your repository&apos;s history and find which model is best
              for it.
            </p>
            <a
              className={`${buttonStyles.primary} mt-6 w-full`}
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
          <nav
            aria-label="Elsewhere"
            className="mt-6 flex items-center justify-center gap-5 text-[13px] text-muted-foreground"
          >
            <OutLink href="https://dari.dev">dari.dev</OutLink>
            <a
              href="https://github.com/mupt-ai/self-bench"
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub"
              title="GitHub"
              className="hit relative inline-flex rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <GitHubMark />
            </a>
          </nav>
        </div>
      </main>
    </div>
  );
}
