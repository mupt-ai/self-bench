import { useEffect, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { DariMark } from "../Lockup";
import { useDocumentTitle, useSession } from "../session";

const ERRORS: Record<string, string> = {
  state: "That sign-in attempt expired. Try again.",
  denied: "GitHub sign-in was cancelled.",
  github: "GitHub sign-in failed. Try again.",
};

export function LoginPage() {
  useDocumentTitle("Sign In — self-bench by dari.dev");
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
    <div className="flex min-h-svh items-center justify-center px-6 py-12">
      <div className="w-full max-w-[320px]">
        <div className="flex flex-col items-center text-center">
          <Link to="/" aria-label="self-bench Home" className="mb-5 block [&_svg]:size-14">
            <DariMark />
          </Link>
          <h1 className="font-mono text-3xl font-medium leading-tight tracking-[-0.06em] text-ink">
            self-bench
          </h1>
          <p className="mt-2 font-mono text-sm text-muted">by dari.dev</p>
          <a
            className="mt-10 flex h-12 w-full items-center justify-center gap-3 border border-mint bg-mint font-mono text-sm font-medium text-bg hover:bg-mint-bright aria-disabled:cursor-wait aria-disabled:hover:bg-mint [&_svg]:size-4 [&_svg]:fill-current"
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
            <p
              role="alert"
              className="mt-5 w-full border border-danger/30 bg-danger/5 px-4 py-3 text-left font-mono text-sm leading-6 text-danger"
            >
              {ERRORS[error] ?? ERRORS.github}
            </p>
          )}
        </div>
        <div className="mt-8 flex items-center justify-center gap-4 font-mono text-sm text-muted [&_a:hover]:text-ink">
          <a href="https://dari.dev">dari.dev</a>
          <span className="text-line-strong" aria-hidden="true">
            ·
          </span>
          <a href="https://github.com/mupt-ai/self-bench">GitHub</a>
        </div>
      </div>
    </div>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
