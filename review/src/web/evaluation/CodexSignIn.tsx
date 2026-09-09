import { ArrowUpRight, Check, Copy, Terminal } from "lucide-react";
import React from "react";
import type { CodexLoginStatus } from "../../../../src/evaluation/codex-login";
import { Skeleton } from "../LoadingSkeleton";
import { Button, buttonStyles } from "../ui";
import { evaluationRequest } from "./api";

export function CodexSignIn({
  org,
  name,
  onActiveChange,
  onDone,
}: {
  org: string;
  name: string;
  onActiveChange(active: boolean): void;
  onDone(): Promise<void>;
}) {
  const url = `/api/orgs/${encodeURIComponent(org)}/credentials/codex-login`;
  const [session, setSession] = React.useState<CodexLoginStatus>();
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState("");
  const [copied, setCopied] = React.useState(false);
  const [copyHint, setCopyHint] = React.useState("");
  const attempt = React.useRef<string>(undefined);
  const alive = React.useRef(true);
  const completed = React.useRef(onDone);
  completed.current = onDone;
  const code = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (attempt.current)
        void evaluationRequest(`${url}/${attempt.current}/cancel`, {}).catch(() => undefined);
    };
  }, [url]);
  const sessionId = session?.id;
  React.useEffect(() => {
    if (!sessionId || error) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await evaluationRequest<CodexLoginStatus>(`${url}/${sessionId}`);
        if (disposed) return;
        if (next.status === "ready") {
          setSession({ ...next, status: "saving" });
          const credential = await evaluationRequest<NonNullable<CodexLoginStatus["credential"]>>(
            `${url}/${sessionId}/complete`,
            {},
          );
          if (!disposed) {
            setSession({ ...next, status: "saved", credential });
            onActiveChange(false);
            void completed.current();
          }
          return;
        }
        setSession(next);
        if (next.status === "failed" || next.status === "saved") {
          onActiveChange(false);
          if (next.status === "saved") void completed.current();
          return;
        }
        timer = setTimeout(poll, 1500);
      } catch (cause) {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : "Could not check sign-in. Try again.");
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [sessionId, error, url, onActiveChange]);
  const start = async () => {
    setStarting(true);
    setError("");
    setCopied(false);
    setCopyHint("");
    onActiveChange(true);
    try {
      const next = await evaluationRequest<CodexLoginStatus>(url, { name: name.trim() });
      if (!alive.current) {
        void evaluationRequest(`${url}/${next.id}/cancel`, {}).catch(() => undefined);
        return;
      }
      attempt.current = next.id;
      setSession(next);
    } catch (cause) {
      if (alive.current) {
        setError(cause instanceof Error ? cause.message : "Could not start sign-in");
        onActiveChange(false);
      }
    } finally {
      if (alive.current) setStarting(false);
    }
  };
  if (session?.status === "saved")
    return (
      <div className="border border-mint/25 bg-mint/5 p-5" role="status">
        <Check className="mb-3 text-mint" size={22} aria-hidden="true" />
        <h3 className="font-semibold">Codex Connected</h3>
        <p className="mt-2 text-sm leading-6 text-muted">
          {session.credential?.name} is saved and ready for Codex runs in {org}.
        </p>
        <Button type="button" className="mt-5" variant="primary" onClick={() => void onDone()}>
          Done
        </Button>
      </div>
    );
  return (
    <div className="space-y-4">
      {!session && !starting ? (
        <div className="border border-line bg-bg p-5">
          <Terminal size={24} className="mb-3 text-mint" aria-hidden="true" />
          <h3 className="text-sm font-semibold">Connect Your ChatGPT Account</h3>
          <p className="mt-2 text-sm leading-6 text-muted">
            You’ll receive a one-time code to enter on OpenAI. After you approve, your sign-in is
            saved for Codex runs across {org}.
          </p>
          <Button
            type="button"
            className="mt-5 w-full"
            variant="primary"
            disabled={!name.trim()}
            onClick={() => void start()}
          >
            Sign in with ChatGPT
            <ArrowUpRight size={15} aria-hidden="true" />
          </Button>
        </div>
      ) : starting || session?.status === "starting" ? (
        <div
          role="status"
          aria-label="Preparing Sign-In"
          className="space-y-4 border border-line bg-bg p-5"
        >
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-9 w-full" />
          <span className="sr-only">Preparing your sign-in code…</span>
        </div>
      ) : session?.status === "failed" ? (
        <div role="alert" className="border border-danger/30 p-5">
          <p className="text-sm leading-6 text-danger">{session.error}</p>
          <Button type="button" className="mt-4" onClick={() => void start()}>
            Start Again
          </Button>
        </div>
      ) : (
        <div className="border border-line bg-bg p-5">
          <ol className="space-y-5 text-sm">
            <li>
              <p className="mb-3 font-medium">
                <span className="mr-2 font-mono text-dim">01</span>Copy Your One-Time Code
              </p>
              <div className="flex border border-line-strong bg-surface">
                <input
                  ref={code}
                  aria-label="One-Time Code"
                  readOnly
                  value={session?.instructions?.userCode ?? ""}
                  onFocus={(event) => event.target.select()}
                  className="min-w-0 flex-1 bg-transparent p-3 text-center font-mono text-xl tracking-[0.15em] text-mint outline-none"
                />
                <button
                  type="button"
                  aria-label={copied ? "Code Copied" : "Copy Code"}
                  title={copied ? "Code Copied" : "Copy Code"}
                  className="border-l border-line px-4 text-muted hover:text-mint"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(session?.instructions?.userCode ?? "");
                      setCopied(true);
                    } catch {
                      code.current?.focus();
                      code.current?.select();
                      setCopyHint("Copy the selected code, then open OpenAI to continue.");
                    }
                  }}
                >
                  {copied ? (
                    <Check size={16} aria-hidden="true" />
                  ) : (
                    <Copy size={16} aria-hidden="true" />
                  )}
                </button>
              </div>
              {copyHint && (
                <p role="status" className="mt-2 text-xs text-muted">
                  {copyHint}
                </p>
              )}
            </li>
            <li>
              <p className="mb-3 font-medium">
                <span className="mr-2 font-mono text-dim">02</span>Approve on OpenAI
              </p>
              <a
                className={`${buttonStyles.primary} w-full`}
                href={session?.instructions?.verificationUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open OpenAI
                <ArrowUpRight size={15} aria-hidden="true" />
              </a>
              <p className="mt-2 text-xs leading-5 text-muted">
                Sign in, enter the code, and approve access. Then return here.
              </p>
            </li>
          </ol>
          <p
            className="mt-5 flex items-center gap-2 border-t border-line pt-4 text-xs text-muted"
            role="status"
          >
            <span
              className="size-1.5 animate-pulse bg-mint motion-reduce:animate-none"
              aria-hidden="true"
            />
            {session?.status === "saving"
              ? "Saving your credential…"
              : "Waiting for approval on OpenAI…"}
          </p>
        </div>
      )}
      {error && (
        <div role="alert" className="text-sm leading-6 text-danger">
          <p>{error}</p>
          {session && (
            <div className="mt-2 flex gap-2">
              <Button type="button" onClick={() => setError("")}>
                Retry
              </Button>
              <Button type="button" variant="ghost" onClick={() => void start()}>
                Start Again
              </Button>
            </div>
          )}
        </div>
      )}
      <p className="text-xs leading-5 text-muted">
        Device code login must be enabled in your ChatGPT security settings. Your ChatGPT
        subscription limits apply.
      </p>
    </div>
  );
}
