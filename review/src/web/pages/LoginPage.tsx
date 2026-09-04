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
    <div className="page login-page">
      <div className="wrap">
        <Lockup />
        <div className="card">
          <div className="eyebrow">Sign in</div>
          <h1>Continue to self-bench</h1>
          <p className="sub">
            Build verified coding tasks from your repository’s pull requests, review them, and run
            evals across harness, model, and thinking levels.
          </p>
          <a className="btn" href="/auth/github">
            <GitHubMark />
            Continue with GitHub
          </a>
          {error && <p className="error">{ERRORS[error] ?? ERRORS.github}</p>}
        </div>
        <div className="foot">
          <a href="https://dari.dev">dari.dev</a>
          <span className="dot" aria-hidden="true">
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
