import { Navigate, useSearchParams } from "react-router";
import { Lockup } from "../Lockup";
import { useDocumentTitle, useSession } from "../session";

const ERRORS: Record<string, string> = {
  state: "That sign-in attempt expired. Try again.",
  denied: "GitHub sign-in was cancelled.",
  github: "GitHub sign-in failed. Try again.",
};

export function LoginPage() {
  useDocumentTitle("Sign in — self-bench by dari.dev");
  const { session } = useSession();
  const [params] = useSearchParams();
  const error = params.get("error");
  if (session.status === "signed-in") return <Navigate to="/" replace />;
  return (
    <div className=" flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-[440px]">
        <Lockup />
        <div className="border border-line bg-surface p-6 sm:p-10 [&_h1]:text-xl [&_h1]:leading-tight [&_h1]:font-semibold">
          <div className="font-mono text-[10px] font-medium tracking-[0.14em] text-mint uppercase">
            Sign in
          </div>
          <h1>Continue to self-bench</h1>
          <p className="mt-1.5 text-sm text-muted">
            Build verified coding tasks from your repository’s pull requests, review them, and run
            evals across harness, model, and thinking levels.
          </p>
          <a
            className="mt-7 flex h-11 w-full items-center justify-center gap-2.5 border border-mint bg-mint font-sans text-sm font-bold text-bg hover:bg-mint-bright [&_svg]:size-4 [&_svg]:fill-current"
            href="/auth/github"
          >
            <GitHubMark />
            Continue with GitHub
          </a>
          {error && (
            <p className="mt-4 font-mono text-xs leading-relaxed text-danger">
              {ERRORS[error] ?? ERRORS.github}
            </p>
          )}
        </div>
        <div className="mt-6 flex items-center justify-center gap-3 font-mono text-[11px] font-medium text-dim [&_a:hover]:text-ink">
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
